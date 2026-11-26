/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { confirmAction, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import {
    ChannelStore,
    ConfirmModal,
    FluxDispatcher,
    ListScrollerThin,
    MessageActions,
    Modal,
    openMediaModal,
    openModal,
    PendingReplyStore,
    RestAPI,
    ScrollerThin,
    SearchableSelect,
    SelectedChannelStore,
    showToast,
    TextInput,
    useEffect,
    useMemo,
    useRef,
    UserSettingsActionCreators,
    UserSettingsProtoStore,
    useState,
    useStateFromStores,
} from "@webpack/common";

const author = { name: "Jumble", id: 1135976262234542233n };
const logger = new Logger("GifVault");
const DATA_KEY = "GifVault_library";
const RESTORE_CHANNEL_KEY = "GifVault_restoreChannelId";
const UNFILED = "Unfiled";
const BACKUP_VERSION = 1;
const DEFAULT_OPEN_KEYBIND = "Ctrl+Shift+G";
const { uniqueId } = findByPropsLazy("uniqueId");
const Native = !IS_WEB
    ? VencordNative.pluginHelpers.GifVault as PluginNative<typeof import("./native")>
    : undefined;

type WindowWithDirectoryPicker = Window & {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite"; }) => Promise<FileSystemDirectoryHandle>;
};

type FileSystemDirectoryHandleWithPermission = FileSystemDirectoryHandle & {
    requestPermission?: (options?: { mode?: "read" | "readwrite"; }) => Promise<PermissionState>;
};

const settings = definePluginSettings({
    openMenuKeybind: {
        type: OptionType.STRING,
        displayName: "Open menu keybind",
        description: "Keyboard shortcut to open GIF Vault, for example Ctrl+Shift+G.",
        default: DEFAULT_OPEN_KEYBIND,
        isValid: value => typeof value === "string" && !!getKeybindModifiers(value),
    },
});

const TILE_SIZES = {
    small: { label: "Small", minWidth: 202, rowHeight: 222 },
    medium: { label: "Medium", minWidth: 282, rowHeight: 262 },
    large: { label: "Large", minWidth: 380, rowHeight: 310 },
} as const;

type GifTileSize = keyof typeof TILE_SIZES;
type GifSortOrder = "added-oldest" | "added-newest" | "title-asc" | "title-desc";

function isGifSortOrder(value: string): value is GifSortOrder {
    return (
        value === "added-oldest" ||
        value === "added-newest" ||
        value === "title-asc" ||
        value === "title-desc"
    );
}

function getKeybindModifiers(value: string) {
    const parts = value
        .split("+")
        .map(part => part.trim().toLocaleLowerCase())
        .filter(Boolean);
    if (!parts.length) return;

    const modifiers = {
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
    };
    let key: string | undefined;
    for (const part of parts) {
        switch (part) {
            case "ctrl":
            case "control":
                if (modifiers.ctrl) return;
                modifiers.ctrl = true;
                break;
            case "alt":
                if (modifiers.alt) return;
                modifiers.alt = true;
                break;
            case "shift":
                if (modifiers.shift) return;
                modifiers.shift = true;
                break;
            case "meta":
            case "cmd":
            case "command":
                if (modifiers.meta) return;
                modifiers.meta = true;
                break;
            default:
                if (key) return;
                key = part;
        }
    }

    if (!key || ["ctrl", "control", "alt", "shift", "meta", "cmd", "command"].includes(key)) return;
    return { ...modifiers, key };
}

function onKeydown(event: KeyboardEvent) {
    if (event.repeat || document.querySelector(".vc-gif-vault")) return;
    const { key: pressedKey, ctrlKey, altKey, shiftKey, metaKey, target } = event;
    const keybind = getKeybindModifiers(settings.store.openMenuKeybind);
    if (!keybind) return;
    const { key: configuredKey, ctrl, alt, shift, meta } = keybind;
    if (pressedKey.toLocaleLowerCase() !== configuredKey) return;
    if (ctrlKey !== ctrl || altKey !== alt || shiftKey !== shift || metaKey !== meta) return;

    if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, [role='textbox']"))
    )
        return;

    event.preventDefault();
    openGifVault();
}

interface FavoriteGif {
    key: string;
    title: string;
    url: string;
    downloadUrl?: string;
    previewUrl: string;
    format: number;
    width?: number;
    height?: number;
    gifSrc?: () => unknown;
}

// reminder on what urls to use:
// discords favorite gif map uses the gif source url as the key, use the key for identity
// discord cdn keys require signatures from the src proxy url for a working download
interface GifLibraryData {
    folders: string[];
    assignments: Record<string, string[]>;
    titleOverrides: Record<string, string>;
    layoutSize: GifTileSize;
}

const EMPTY_LIBRARY: GifLibraryData = {
    folders: [],
    assignments: {},
    titleOverrides: {},
    layoutSize: "small",
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function uint32OrZero(value: unknown): number {
    return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 0xffffffff
        ? value
        : 0;
}

function positiveDimensionOr32(value: unknown): number {
    return uint32OrZero(value) || 32;
}

function httpUrl(value: unknown): string | undefined {
    if (typeof value !== "string") return;
    try {
        const url = new URL(value);
        if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch {
        return;
    }
}

function normalizeGifProxyUrl(value: unknown): string | undefined {
    const validUrl = httpUrl(value);
    if (!validUrl) return;

    const url = new URL(validUrl);
    const hostname = url.hostname.toLocaleLowerCase();
    if (hostname !== "media.discordapp.net" && !hostname.endsWith(".discordapp.net"))
        return url.href;

    const extension = url.pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLocaleLowerCase();
    if (extension === "gif" || extension === "webp") {
        url.searchParams.set("format", "webp");
        url.searchParams.set("animated", "true");
    }

    for (const param of ["width", "height", "size"]) url.searchParams.delete(param);
    return url.href;
}

function normalizeGifFavoriteKey(value: unknown): string | undefined {
    const validUrl = httpUrl(value);
    if (!validUrl) return;

    const url = new URL(validUrl);
    const hostname = url.hostname.toLocaleLowerCase();
    if (
        (hostname === "cdn.discordapp.com" ||
            hostname === "media.discordapp.net" ||
            hostname.endsWith(".discordapp.net")) &&
        (url.pathname.startsWith("/attachments/") ||
            url.pathname.startsWith("/ephemeral-attachments/"))
    ) {
        for (const param of ["ex", "is", "hm"]) url.searchParams.delete(param);
    }
    return url.href;
}

function getFavoriteIdentityUrl(key: string, value: Record<string, unknown>): string | undefined {
    return normalizeGifFavoriteKey(key) ??
        normalizeGifFavoriteKey(value.url) ??
        normalizeGifFavoriteKey(value.src);
}

function getFavoriteDownloadUrl(key: string, value: Record<string, unknown>): string | undefined {
    const keyUrl = httpUrl(key);
    const srcUrl = normalizeGifProxyUrl(value.src);
    if (keyUrl && srcUrl) {
        const key = new URL(keyUrl);
        const src = new URL(srcUrl);
        const hostname = key.hostname.toLocaleLowerCase();
        if (hostname === "cdn.discordapp.com" && key.pathname === src.pathname) {
            const expires = src.searchParams.get("ex");
            const issuedAt = src.searchParams.get("is");
            const hash = src.searchParams.get("hm");
            if (expires && issuedAt && hash) {
                key.searchParams.set("ex", expires);
                key.searchParams.set("is", issuedAt);
                key.searchParams.set("hm", hash);
                return key.href;
            }
        }
        if (
            hostname === "cdn.discordapp.com" ||
            hostname === "media.discordapp.net" ||
            hostname.endsWith(".discordapp.net")
        )
            return srcUrl;
    }
    return keyUrl ?? httpUrl(value.url) ?? srcUrl;
}

function getFavorites(): FavoriteGif[] {
    const favoriteGifs = UserSettingsProtoStore.frecencyWithoutFetchingLatest.favoriteGifs as
        | {
            gifs?: Record<string, unknown>;
        }
        | undefined;
    if (!favoriteGifs?.gifs) return [];

    const favorites = Object.entries(favoriteGifs.gifs).flatMap(([key, value], fallbackOrder) => {
        if (!isRecord(value)) return [];

        const url = getFavoriteIdentityUrl(key, value);
        const previewUrl =
            normalizeGifProxyUrl(value.src) ??
            normalizeGifProxyUrl(value.url) ??
            normalizeGifProxyUrl(value.gifSrc) ??
            normalizeGifProxyUrl(key);
        if (!url || !previewUrl) return [];
        const downloadUrl = getFavoriteDownloadUrl(key, value);

        return [
            {
                gif: {
                    key,
                    title:
                        typeof value.title === "string" && value.title
                            ? value.title
                            : typeof value.name === "string" && value.name
                                ? value.name
                                : new URL(url).hostname,
                    url,
                    previewUrl,
                    format: value.format === 2 ? 2 : 1,
                    width:
                        typeof value.width === "number" && Number.isFinite(value.width)
                            ? value.width
                            : undefined,
                    height:
                        typeof value.height === "number" && Number.isFinite(value.height)
                            ? value.height
                            : undefined,
                    downloadUrl,
                    gifSrc:
                        typeof value.gifSrc === "function"
                            ? (value.gifSrc as () => unknown)
                            : undefined,
                },
                fallbackOrder,
                order:
                    typeof value.order === "number" && Number.isFinite(value.order)
                        ? value.order
                        : undefined,
            },
        ];
    });

    const hasNativeOrder = favorites.every(({ order }) => order !== undefined);
    favorites.sort((a, b) =>
        hasNativeOrder
            ? a.order! - b.order! || a.fallbackOrder - b.fallbackOrder
            : a.fallbackOrder - b.fallbackOrder,
    );
    return favorites.map(({ gif }) => gif);
}

function getNativeFavoriteMap(): Record<string, unknown> {
    const favoriteGifs = UserSettingsProtoStore.frecencyWithoutFetchingLatest.favoriteGifs as
        | {
            gifs?: Record<string, unknown>;
        }
        | undefined;
    return favoriteGifs?.gifs ?? {};
}

async function getGifUrl(gif: FavoriteGif): Promise<string> {
    if (gif.gifSrc) {
        const resolved = httpUrl(await gif.gifSrc());
        if (resolved) return resolved;
    }
    return gif.downloadUrl ?? gif.url;
}

async function getGifUrlCandidates(gif: FavoriteGif): Promise<string[]> {
    const candidates: string[] = [];
    function addCandidate(value: unknown) {
        const url = normalizeGifProxyUrl(value);
        if (url && !candidates.includes(url)) candidates.push(url);
    }
    if (gif.gifSrc) {
        addCandidate(await gif.gifSrc());
    }
    for (const url of [gif.downloadUrl, gif.url, gif.previewUrl]) addCandidate(url);
    return candidates;
}

function readLibraryData(value: unknown): GifLibraryData {
    if (!isRecord(value)) return EMPTY_LIBRARY;
    const folders = Array.isArray(value.folders)
        ? value.folders.filter(
            (folder): folder is string => typeof folder === "string" && folder.length > 0,
        )
        : [];
    const assignments: Record<string, string[]> = {};
    if (isRecord(value.assignments)) {
        for (const [key, assignedFolders] of Object.entries(value.assignments)) {
            if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
            const values =
                typeof assignedFolders === "string"
                    ? [assignedFolders]
                    : Array.isArray(assignedFolders)
                        ? assignedFolders.filter(
                            (folder): folder is string => typeof folder === "string",
                        )
                        : [];
            const validFolders = [...new Set(values.filter(folder => folders.includes(folder)))];
            if (validFolders.length) assignments[key] = validFolders;
        }
    }
    const titleOverrides: Record<string, string> = {};
    if (isRecord(value.titleOverrides)) {
        for (const [key, title] of Object.entries(value.titleOverrides)) {
            if (
                key === "__proto__" ||
                key === "constructor" ||
                key === "prototype" ||
                typeof title !== "string"
            )
                continue;
            const trimmedTitle = title.trim();
            if (trimmedTitle) titleOverrides[key] = trimmedTitle;
        }
    }
    const layoutSize =
        value.layoutSize === "medium" || value.layoutSize === "large" ? value.layoutSize : "small";
    return { folders: [...new Set(folders)], assignments, titleOverrides, layoutSize };
}

function selectedFolderValue(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (isRecord(value) && typeof value.value === "string") return value.value;
}

function getSerializableFavoriteMap() {
    const favorites = Object.create(null) as Record<string, Record<string, unknown>>;
    for (const [key, value] of Object.entries(getNativeFavoriteMap())) {
        if (!isRecord(value)) continue;

        const serializable = Object.fromEntries(
            Object.entries(value).filter(
                ([, field]) =>
                    typeof field === "string" ||
                    typeof field === "number" ||
                    typeof field === "boolean" ||
                    field === null,
            ),
        );
        const src = normalizeGifProxyUrl(value.src);
        if (src) serializable.src = src;
        if (httpUrl(value.url) || httpUrl(value.src) || httpUrl(key)) favorites[key] = serializable;
    }
    return favorites;
}

function readBackupFavorites(value: unknown): Record<string, Record<string, unknown>> {
    if (!isRecord(value)) return {};

    const favorites = Object.create(null) as Record<string, Record<string, unknown>>;
    for (const [key, entry] of Object.entries(value)) {
        if (!isRecord(entry)) continue;

        const url = getFavoriteIdentityUrl(key, entry);
        if (!url) continue;

        const favorite = Object.fromEntries(
            Object.entries(entry).filter(
                ([, field]) =>
                    typeof field === "string" ||
                    typeof field === "number" ||
                    typeof field === "boolean" ||
                    field === null,
            ),
        );
        favorite.format = entry.format === 2 ? 2 : 1;
        favorite.url = url;
        favorite.src = httpUrl(entry.src) ?? url;
        favorite.width = positiveDimensionOr32(entry.width);
        favorite.height = positiveDimensionOr32(entry.height);
        const favoriteKey = normalizeGifFavoriteKey(httpUrl(key) ? key : url);
        if (favoriteKey) favorites[favoriteKey] = favorite;
    }
    return favorites;
}

async function exportGifVaultBackup() {
    const library = readLibraryData(await DataStore.get<unknown>(DATA_KEY));
    const backup = {
        version: BACKUP_VERSION,
        favoriteGifs: getSerializableFavoriteMap(),
        library,
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `gif-vault-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getSafeFilenamePart(value: string) {
    const safe = value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[._]+|[._]+$/g, "")
        .slice(0, 80);
    return safe || "gif";
}

function getGifExportName(gif: FavoriteGif, library: GifLibraryData) {
    if (library.titleOverrides[gif.key]) return library.titleOverrides[gif.key];

    const favorite = getNativeFavoriteMap()[gif.key];
    if (isRecord(favorite)) {
        const title =
            (typeof favorite.title === "string" && favorite.title.trim()) ||
            (typeof favorite.name === "string" && favorite.name.trim());
        if (title) return title;
    }

    return library.assignments[gif.key]?.join("_") || "unfiled";
}

function getGifExtension(contentType: string, url: string, format: number) {
    const mimeExtensions: Record<string, string> = {
        "image/avif": "avif",
        "image/gif": "gif",
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "video/mp4": "mp4",
        "video/webm": "webm",
    };
    const mimeExtension = mimeExtensions[contentType.split(";")[0].trim().toLocaleLowerCase()];
    if (mimeExtension) return mimeExtension;

    const urlExtension = new URL(url).pathname
        .match(/\.([a-z0-9]{1,5})$/i)?.[1]
        ?.toLocaleLowerCase();
    if (urlExtension && Object.values(mimeExtensions).includes(urlExtension)) return urlExtension;
    return format === 2 ? "mp4" : "gif";
}

async function writeDirectoryFile(
    directory: FileSystemDirectoryHandle,
    filename: string,
    content: Blob | string,
) {
    const file = await directory.getFileHandle(filename, { create: true });
    const writable = await file.createWritable();
    await writable.write(content);
    await writable.close();
}

interface GifFolderExportProgress {
    completed: number;
    total: number;
    phase: "preparing" | "downloading" | "manifest" | "complete" | "cancelled" | "error";
    failed?: number;
}

let gifExportProgress: GifFolderExportProgress | undefined;
let gifExportBusy = false;
let gifExportAbortController: AbortController | null = null;
const gifExportSubscribers = new Set<(progress: GifFolderExportProgress | undefined, busy: boolean) => void>();

function updateGifExportStatus(
    progress: GifFolderExportProgress | undefined,
    busy = gifExportBusy,
) {
    gifExportProgress = progress;
    gifExportBusy = busy;
    for (const subscriber of gifExportSubscribers)
        subscriber(gifExportProgress, gifExportBusy);
}

function subscribeGifExportStatus(
    subscriber: (progress: GifFolderExportProgress | undefined, busy: boolean) => void,
) {
    gifExportSubscribers.add(subscriber);
    subscriber(gifExportProgress, gifExportBusy);
    return () => {
        gifExportSubscribers.delete(subscriber);
    };
}

async function exportFavoriteGifsToNativeFolder(
    folderPath: string,
    signal: AbortSignal,
    onProgress: (progress: GifFolderExportProgress) => void,
) {
    if (!Native) throw new Error("Native folder export is unavailable.");

    const library = readLibraryData(await DataStore.get<unknown>(DATA_KEY));
    const gifs = getFavorites();
    if (!gifs.length) throw new Error("No favorite GIFs are currently available to download.");

    const existingByKey = new Map<string, { filename: string; }>();
    const existingByUrl = new Map<string, { filename: string; }>();
    const manifestJson = await Native.readTextFile(folderPath, "gif-vault-export.json");
    if (manifestJson) {
        try {
            const existingManifest = JSON.parse(manifestJson) as unknown;
            if (isGifFolderManifest(existingManifest) && Array.isArray(existingManifest.files)) {
                for (const file of existingManifest.files) {
                    if (!isRecord(file) || typeof file.filename !== "string" || typeof file.key !== "string")
                        continue;
                    existingByKey.set(file.key, { filename: file.filename });
                    const favorite = existingManifest.favoriteGifs?.[file.key];
                    if (isRecord(favorite)) {
                        const identityUrl = getFavoriteIdentityUrl(file.key, favorite);
                        if (identityUrl) existingByUrl.set(identityUrl, { filename: file.filename });
                    }
                }
            }
        } catch (error) {
            logger.error("Could not parse an existing GIF folder manifest", error);
        }
    }

    const files: Array<{
        index: number;
        filename: string;
        key: string;
        title: string;
        folders: string[];
    }> = [];
    const failed: Array<{ title: string; error: string; }> = [];
    onProgress({ completed: 0, total: gifs.length, phase: "downloading" });

    for (const [index, gif] of gifs.entries()) {
        if (signal.aborted) throw new DOMException("The export was cancelled.", "AbortError");
        const title = getGifExportName(gif, library);
        const existingEntry = existingByKey.get(gif.key) ?? existingByUrl.get(gif.url);
        if (existingEntry) {
            const size = await Native.fileSize(folderPath, existingEntry.filename);
            if (size > 0) {
                files.push({
                    index: index + 1,
                    filename: existingEntry.filename,
                    key: gif.key,
                    title,
                    folders: library.assignments[gif.key] ?? [],
                });
                onProgress({ completed: index + 1, total: gifs.length, phase: "downloading" });
                continue;
            }
        }

        let response: Response | undefined;
        let url: string | undefined;
        let lastError: unknown;
        for (const candidate of await getGifUrlCandidates(gif)) {
            if (signal.aborted) throw new DOMException("The export was cancelled.", "AbortError");
            try {
                const candidateResponse = await fetch(candidate, { signal });
                if (candidateResponse.ok) {
                    response = candidateResponse;
                    url = candidate;
                    break;
                }
                lastError = new Error(`HTTP ${candidateResponse.status}`);
            } catch (error) {
                lastError = error;
            }
        }
        if (!response || !url) {
            failed.push({
                title: gif.title,
                error: lastError instanceof Error ? lastError.message : "No downloadable URL",
            });
            onProgress({ completed: index + 1, total: gifs.length, phase: "downloading" });
            continue;
        }

        const blob = await response.blob();
        const filename = existingEntry
            ? existingEntry.filename
            : `${getSafeFilenamePart(title)}_${index + 1}.${getGifExtension(
                blob.type,
                url,
                gif.format,
            )}`;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000)
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        await Native.writeBase64File(folderPath, filename, btoa(binary));
        files.push({
            index: index + 1,
            filename,
            key: gif.key,
            title,
            folders: library.assignments[gif.key] ?? [],
        });
        onProgress({ completed: index + 1, total: gifs.length, phase: "downloading" });
    }

    if (signal.aborted) throw new DOMException("The export was cancelled.", "AbortError");
    onProgress({ completed: gifs.length, total: gifs.length, phase: "manifest", failed: failed.length });
    const manifest = {
        format: "gif-vault-folder-export",
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        favoriteGifs: getSerializableFavoriteMap(),
        library,
        files,
        failed,
    };
    await Native.writeTextFile(folderPath, "gif-vault-export.json", JSON.stringify(manifest, null, 2));
    return failed.length;
}

async function exportFavoriteGifsToFolder(
    directory: FileSystemDirectoryHandle,
    signal: AbortSignal,
    onProgress: (progress: GifFolderExportProgress) => void,
) {
    const library = readLibraryData(await DataStore.get<unknown>(DATA_KEY));
    const gifs = getFavorites();
    if (!gifs.length)
        throw new Error("No favorite GIFs are currently available to download.");
    const existingFilesByKey = new Map<string, {
        index: number;
        filename: string;
        key: string;
        title: string;
        folders: string[];
    }>();
    const existingFilesByUrl = new Map<string, {
        index: number;
        filename: string;
        key: string;
        title: string;
        folders: string[];
    }>();
    try {
        const existingManifest = await readDirectoryManifest(directory);
        if (isGifFolderManifest(existingManifest) && Array.isArray(existingManifest.files)) {
            for (const file of existingManifest.files) {
                if (
                    !isRecord(file) ||
                    typeof file.filename !== "string" ||
                    typeof file.key !== "string"
                ) continue;

                const existingFile = {
                    index: typeof file.index === "number" ? file.index : 0,
                    filename: file.filename,
                    key: file.key,
                    title: typeof file.title === "string" ? file.title : "gif",
                    folders: Array.isArray(file.folders)
                        ? file.folders.filter((folder): folder is string => typeof folder === "string")
                        : [],
                };
                existingFilesByKey.set(existingFile.key, existingFile);

                const favorite = existingManifest.favoriteGifs?.[existingFile.key];
                if (isRecord(favorite)) {
                    const identityUrl = getFavoriteIdentityUrl(existingFile.key, favorite);
                    if (identityUrl) existingFilesByUrl.set(identityUrl, existingFile);
                }
            }
        }
    } catch (error) {
        logger.error("Could not read an existing GIF folder manifest; downloading normally", error);
    }

    const files: Array<{
        index: number;
        filename: string;
        key: string;
        title: string;
        folders: string[];
    }> = [];
    const failed: Array<{ title: string; error: string; }> = [];
    onProgress({ completed: 0, total: gifs.length, phase: "downloading" });

    for (const [index, gif] of gifs.entries()) {
        if (signal.aborted) throw new DOMException("The export was cancelled.", "AbortError");
        const title = getGifExportName(gif, library);
        const existingEntry =
            existingFilesByKey.get(gif.key) ?? existingFilesByUrl.get(gif.url);
        let existingFileExists = false;
        if (existingEntry) {
            try {
                const existingHandle = await directory.getFileHandle(existingEntry.filename);
                existingFileExists = (await existingHandle.getFile()).size > 0;
            } catch {
                existingFileExists = false;
            }
        }
        if (existingFileExists && existingEntry) {
            files.push({
                index: index + 1,
                filename: existingEntry.filename,
                key: gif.key,
                title,
                folders: library.assignments[gif.key] ?? [],
            });
            onProgress({ completed: index + 1, total: gifs.length, phase: "downloading" });
            continue;
        }

        let response: Response | undefined;
        let url: string | undefined;
        let lastError: unknown;
        for (const candidate of await getGifUrlCandidates(gif)) {
            if (signal.aborted) throw new DOMException("The export was cancelled.", "AbortError");
            try {
                const candidateResponse = await fetch(candidate, { signal });
                if (candidateResponse.ok) {
                    response = candidateResponse;
                    url = candidate;
                    break;
                }
                lastError = new Error(`HTTP ${candidateResponse.status}`);
            } catch (error) {
                lastError = error;
            }
        }
        if (!response || !url) {
            failed.push({
                title: gif.title,
                error: lastError instanceof Error ? lastError.message : "No downloadable URL",
            });
            onProgress({ completed: index + 1, total: gifs.length, phase: "downloading" });
            continue;
        }
        let blob: Blob;
        try {
            blob = await response.blob();
        } catch (error) {
            failed.push({
                title: gif.title,
                error: error instanceof Error ? error.message : "Could not read downloaded data",
            });
            onProgress({ completed: index + 1, total: gifs.length, phase: "downloading" });
            continue;
        }
        const filename = existingEntry
            ? existingEntry.filename
            : `${getSafeFilenamePart(title)}_${index + 1}.${getGifExtension(
                blob.type,
                url,
                gif.format,
            )}`;
        await writeDirectoryFile(directory, filename, blob);
        files.push({
            index: index + 1,
            filename,
            key: gif.key,
            title,
            folders: library.assignments[gif.key] ?? [],
        });
        onProgress({ completed: index + 1, total: gifs.length, phase: "downloading" });
    }

    if (signal.aborted) throw new DOMException("The export was cancelled.", "AbortError");
    onProgress({
        completed: gifs.length,
        total: gifs.length,
        phase: "manifest",
        failed: failed.length,
    });
    const manifest = {
        format: "gif-vault-folder-export",
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        favoriteGifs: getSerializableFavoriteMap(),
        library,
        files,
        failed,
    };
    await writeDirectoryFile(directory, "gif-vault-export.json", JSON.stringify(manifest, null, 2));
    return failed.length;
}

async function importGifVaultBackupData(backup: unknown) {
    if (!isRecord(backup) || backup.version !== BACKUP_VERSION || !isRecord(backup.library))
        throw new Error("This is not a supported GIF Vault backup.");

    const library = readLibraryData(backup.library);
    const importedFavorites = readBackupFavorites(backup.favoriteGifs);
    let addedFavorites = 0;
    const importedKeyMap = new Map<string, string>();
    const importedUrlMap = new Map<string, string>();
    const importedFavoriteUrls = new Map<string, string>();
    for (const [key, favorite] of Object.entries(
        isRecord(backup.favoriteGifs) ? backup.favoriteGifs : {},
    )) {
        if (!isRecord(favorite)) continue;
        const url = getFavoriteIdentityUrl(key, favorite);
        if (url) importedFavoriteUrls.set(key, url);
    }
    for (const [key, favorite] of Object.entries(importedFavorites)) {
        const url = getFavoriteIdentityUrl(key, favorite);
        if (url) importedFavoriteUrls.set(key, url);
    }
    if (Object.keys(importedFavorites).length) {
        await UserSettingsActionCreators.FrecencyUserSettingsActionCreators.updateAsync(
            "favoriteGifs",
            current => {
                if (!isRecord(current))
                    throw new Error("Discord's favorite GIF settings are unavailable.");
                const gifs = isRecord(current.gifs) ? current.gifs : {};
                current.gifs = gifs;

                const existingUrls = new Set<string>();
                const existingUrlKeys = new Map<string, string>();
                let maxExistingOrder = -1;
                for (const [key, favorite] of Object.entries(gifs)) {
                    if (!isRecord(favorite)) continue;
                    const url = getFavoriteIdentityUrl(key, favorite);
                    if (url) {
                        existingUrls.add(url);
                        existingUrlKeys.set(url, key);
                    }
                    if (typeof favorite.order === "number" && Number.isFinite(favorite.order))
                        maxExistingOrder = Math.max(maxExistingOrder, favorite.order);
                }

                let nextOrder = maxExistingOrder + 1;
                for (const favorite of Object.values(gifs)) {
                    if (!isRecord(favorite)) continue;
                    if (typeof favorite.order === "number" && Number.isFinite(favorite.order))
                        continue;
                    favorite.order = nextOrder++;
                }

                const orderedImports = Object.entries(importedFavorites).map(
                    ([key, favorite], fallbackOrder) => ({
                        key,
                        favorite,
                        fallbackOrder,
                        order:
                            typeof favorite.order === "number" && Number.isFinite(favorite.order)
                                ? favorite.order
                                : undefined,
                    }),
                );
                orderedImports.sort((a, b) =>
                    a.order !== undefined && b.order !== undefined
                        ? a.order - b.order || a.fallbackOrder - b.fallbackOrder
                        : a.order !== undefined
                            ? -1
                            : b.order !== undefined
                                ? 1
                                : a.fallbackOrder - b.fallbackOrder,
                );

                for (const { key, favorite } of orderedImports) {
                    const url = getFavoriteIdentityUrl(key, favorite);
                    if (url && existingUrls.has(url)) {
                        importedUrlMap.set(url, existingUrlKeys.get(url)!);
                        continue;
                    }

                    if (Object.hasOwn(gifs, key))
                        throw new Error("A GIF favorite already uses this URL key.");
                    gifs[key] = favorite;
                    if (url) {
                        existingUrls.add(url);
                        existingUrlKeys.set(url, key);
                        importedKeyMap.set(key, key);
                        importedUrlMap.set(url, key);
                    }
                    favorite.order = nextOrder++;
                    addedFavorites++;
                }
            },
            0,
            (error: unknown) => {
                logger.error("Failed to save imported favorite GIFs to Discord", error);
                showToast({
                    text: "GIF Vault could not save imported favorite GIFs to Discord. Check the Vencord console for details.",
                    variant: "critical",
                });
            },
        );
    }

    const currentLibrary = readLibraryData(await DataStore.get<unknown>(DATA_KEY));
    const mergedLibrary: GifLibraryData = {
        folders: [...new Set([...currentLibrary.folders, ...library.folders])],
        assignments: { ...currentLibrary.assignments },
        titleOverrides: { ...currentLibrary.titleOverrides },
        layoutSize: currentLibrary.layoutSize,
    };

    for (const [key, assignedFolders] of Object.entries(library.assignments)) {
        const url = importedFavoriteUrls.get(key);
        const actualKey = importedKeyMap.get(key) ?? (url ? importedUrlMap.get(url) : undefined);
        if (!actualKey) continue;
        const validFolders = assignedFolders.filter(folder =>
            mergedLibrary.folders.includes(folder),
        );
        mergedLibrary.assignments[actualKey] = [
            ...new Set([...(mergedLibrary.assignments[actualKey] ?? []), ...validFolders]),
        ];
    }

    for (const [key, title] of Object.entries(library.titleOverrides)) {
        const url = importedFavoriteUrls.get(key);
        const actualKey = importedKeyMap.get(key) ?? (url ? importedUrlMap.get(url) : undefined);
        if (actualKey && !Object.hasOwn(mergedLibrary.titleOverrides, actualKey))
            mergedLibrary.titleOverrides[actualKey] = title;
    }

    await DataStore.set(DATA_KEY, mergedLibrary);
    return addedFavorites;
}

async function importGifVaultBackup(file: File) {
    return importGifVaultBackupData(JSON.parse(await file.text()) as unknown);
}

interface GifFolderManifestFile {
    index: number;
    filename: string;
    key: string;
    title: string;
    folders: string[];
}

interface GifFolderManifest {
    format: "gif-vault-folder-export";
    version: number;
    favoriteGifs?: Record<string, Record<string, unknown>>;
    library?: unknown;
    files?: GifFolderManifestFile[];
}

interface GifFolderRestoreProgress {
    completed: number;
    total: number;
    phase: "preparing" | "checking" | "uploading" | "importing" | "complete" | "cancelled";
}

async function readDirectoryManifest(directory: FileSystemDirectoryHandle) {
    try {
        const handle = await directory.getFileHandle("gif-vault-export.json");
        return JSON.parse(await (await handle.getFile()).text()) as unknown;
    } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") return;
        throw error;
    }
}

type GifFolderDirectory = FileSystemDirectoryHandle | string;

async function readGifFolderFile(directory: GifFolderDirectory, filename: string) {
    if (typeof directory !== "string") {
        const handle = await directory.getFileHandle(filename);
        return handle.getFile();
    }

    if (!Native) throw new Error("Native GIF folder access is unavailable.");
    const base64 = await Native.readFileBase64(directory, filename);
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    return new File([bytes as Uint8Array<ArrayBuffer>], filename);
}

interface GifFolderManifestCandidate {
    filename: string;
    read: () => Promise<string | undefined>;
}

async function findGifFolderManifest(candidates: GifFolderManifestCandidate[]) {
    const canonical = candidates.find(candidate => candidate.filename === "gif-vault-export.json");
    if (canonical) {
        const content = await canonical.read();
        if (content === undefined)
            throw new Error("The GIF Vault folder manifest could not be read.");
        const manifest = JSON.parse(content) as unknown;
        if (!isGifFolderManifest(manifest))
            throw new Error("The selected GIF Vault folder manifest is not supported.");
        return { manifest, filename: canonical.filename };
    }

    const validCandidates: Array<{ manifest: unknown; filename: string; }> = [];
    for (const candidate of candidates) {
        const content = await candidate.read();
        if (content === undefined) continue;

        try {
            const manifest = JSON.parse(content) as unknown;
            if (isGifFolderManifest(manifest))
                validCandidates.push({ manifest, filename: candidate.filename });
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    }

    if (validCandidates.length > 1)
        throw new Error("Multiple GIF Vault folder manifests were found. Keep only one in the folder.");
    return validCandidates[0];
}

async function readGifFolderManifest(directory: GifFolderDirectory) {
    if (typeof directory === "string") {
        if (!Native) throw new Error("Native GIF folder access is unavailable.");
        const filenames = await Native.listFiles(directory);
        const candidates = filenames
            .filter(filename => /\.json$/i.test(filename))
            .map(filename => ({
                filename,
                read: () => Native.readTextFile(directory, filename),
            }));
        return findGifFolderManifest(candidates);
    }

    const candidates: GifFolderManifestCandidate[] = [];
    for await (const entry of (directory as any).values()) {
        if (entry.kind !== "file") continue;
        const file = await entry.getFile();
        if (/\.json$/i.test(file.name))
            candidates.push({ filename: file.name, read: () => file.text() });
    }
    return findGifFolderManifest(candidates);
}

async function listGifFolderFiles(directory: GifFolderDirectory, manifestFilename?: string) {
    if (typeof directory === "string") {
        if (!Native) throw new Error("Native GIF folder access is unavailable.");
        const filenames = await Native.listFiles(directory);
        return Promise.all(
            filenames
                .filter(filename => filename !== manifestFilename)
                .map(filename => readGifFolderFile(directory, filename)),
        );
    }

    const files: File[] = [];
    for await (const entry of (directory as any).values()) {
        if (entry.kind !== "file") continue;
        const file = await entry.getFile();
        if (file.name !== manifestFilename) files.push(file);
    }
    return files;
}

function isGifFolderManifest(value: unknown): value is GifFolderManifest {
    return isRecord(value) && value.format === "gif-vault-folder-export";
}

async function isGifUrlReachable(url: string, signal: AbortSignal) {
    try {
        const response = await fetch(url, {
            signal,
            headers: { Range: "bytes=0-1023" },
        });
        if (!response.ok) return false;
        const contentType = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
        if (contentType) return contentType.startsWith("image/") || contentType.startsWith("video/");
        return /\.(gif|avif|webp|jpe?g|png|mp4|webm)(?:$|[?#])/i.test(url);
    } catch {
        return false;
    }
}

async function uploadGifFilesToChannel(
    channelId: string,
    uploads: Array<{ file: File; name: string; }>,
    signal: AbortSignal,
    onProgress: (completed: number) => void,
) {
    const uploaded: Array<{
        name: string;
        url: string;
        proxyUrl: string;
        file: File;
        width?: number;
        height?: number;
    }> = [];

    for (let batchStart = 0; batchStart < uploads.length; batchStart += 10) {
        if (signal.aborted) throw new DOMException("The restore was cancelled.", "AbortError");
        const batch = uploads.slice(batchStart, batchStart + 10);

        let uploadedBatch: Array<{ id: string; upload_url: string; upload_filename: string; }>;
        for (let attempt = 0; attempt < 4; attempt++) {
            if (signal.aborted) throw new DOMException("The restore was cancelled.", "AbortError");
            try {
                const response = await RestAPI.post({
                    url: `/channels/${channelId}/attachments`,
                    body: {
                        files: batch.map((upload, id) => ({
                            filename: upload.file.name,
                            file_size: upload.file.size,
                            id: String(id),
                            is_clip: false,
                        })),
                    },
                }) as {
                    body: {
                        attachments: Array<{ id: string; upload_url: string; upload_filename: string; }>;
                    };
                };
                uploadedBatch = response.body.attachments;
                break;
            } catch (error) {
                if (attempt === 3) throw error;
                await new Promise(resolve => setTimeout(resolve, 1500 * 2 ** attempt));
            }
        }
        if (!uploadedBatch!) throw new Error("Failed to allocate Discord attachments.");

        const attachmentResults = await Promise.all(
            batch.map(async (upload, index) => {
                if (signal.aborted) throw new DOMException("The restore was cancelled.", "AbortError");
                const allocation = uploadedBatch[index];
                if (!allocation) throw new Error(`Discord did not allocate ${upload.file.name}.`);

                const putResponse = await fetch(allocation.upload_url, {
                    method: "PUT",
                    body: upload.file,
                    signal,
                });
                if (!putResponse.ok)
                    throw new Error(`Failed to upload ${upload.file.name}: HTTP ${putResponse.status}`);

                return {
                    name: upload.name,
                    uploadedFilename: allocation.upload_filename,
                    filename: upload.file.name,
                    file: upload.file,
                };
            }),
        );

        const attachmentPayload = attachmentResults.map((attachment, id) => ({
            id: String(id),
            uploaded_filename: attachment.uploadedFilename,
            filename: attachment.filename,
        }));
        const message = await RestAPI.post({
            url: `/channels/${channelId}/messages`,
            body: {
                channel_id: channelId,
                content: "",
                nonce: uniqueId(),
                flags: 0,
                type: 0,
                attachments: attachmentPayload,
            },
        }) as {
            body: {
                attachments?: Array<{
                    url?: string;
                    proxy_url?: string;
                    width?: number;
                    height?: number;
                }>;
            };
        };

        for (const [index, attachment] of (message.body.attachments ?? []).entries()) {
            const url = httpUrl(attachment.url);
            if (!url) continue;
            uploaded.push({
                name: attachmentResults[index].name,
                url,
                proxyUrl: httpUrl(attachment.proxy_url) ?? url,
                file: attachmentResults[index].file,
                width: attachment.width,
                height: attachment.height,
            });
            onProgress(uploaded.length);
        }

        if (batchStart + batch.length < uploads.length)
            await new Promise(resolve => setTimeout(resolve, 1500));
    }

    return uploaded;
}

async function restoreGifFolder(
    directory: GifFolderDirectory,
    uploadExpired: boolean,
    channelId: string | undefined,
    signal: AbortSignal,
    onProgress: (progress: GifFolderRestoreProgress) => void,
) {
    onProgress({ completed: 0, total: 0, phase: "preparing" });
    const selectedManifest = await readGifFolderManifest(directory);
    const manifestValue = selectedManifest?.manifest;
    const manifest = isGifFolderManifest(manifestValue) ? manifestValue : undefined;

    const entries = manifest?.files?.filter(
        (file): file is GifFolderManifestFile =>
            isRecord(file) && typeof file.filename === "string" && typeof file.key === "string",
    ) ?? [];
    const directoryFiles = await listGifFolderFiles(directory, selectedManifest?.filename);

    const manifestFavoriteMap = manifest?.favoriteGifs ?? {};
    const manifestLibrary = readLibraryData(manifest?.library);
    const restoredFavorites: Record<string, Record<string, unknown>> = {};
    const expiredUploads: Array<{
        file: File;
        name: string;
        manifestKey: string;
        manifestEntry?: Record<string, unknown>;
        folders: string[];
        order?: number;
    }> = [];

    const candidatesForEntry = (entry: GifFolderManifestFile) => {
        const favorite = manifestFavoriteMap[entry.key];
        return [
            httpUrl(entry.key),
            httpUrl(favorite?.src),
            httpUrl(favorite?.url),
            httpUrl(favorite?.downloadUrl),
        ].filter((url): url is string => !!url);
    };

    onProgress({
        completed: 0,
        total: manifest ? entries.length : directoryFiles.length,
        phase: "checking",
    });

    for (const [index, entry] of entries.entries()) {
        if (signal.aborted) throw new DOMException("The restore was cancelled.", "AbortError");
        const favorite = manifestFavoriteMap[entry.key];
        let reachableUrl: string | undefined;
        for (const candidate of candidatesForEntry(entry)) {
            if (await isGifUrlReachable(candidate, signal)) {
                reachableUrl = candidate;
                break;
            }
        }

        if (reachableUrl) {
            if (isRecord(favorite)) {
                const favoriteCopy = { ...favorite };
                favoriteCopy.url = getFavoriteIdentityUrl(entry.key, favoriteCopy) ?? reachableUrl;
                favoriteCopy.src = httpUrl(favoriteCopy.src) ?? reachableUrl;
                restoredFavorites[entry.key] = favoriteCopy;
            } else {
                restoredFavorites[entry.key] = {
                    url: reachableUrl,
                    src: reachableUrl,
                    title: entry.title,
                    order: entry.index,
                    keyIsUrl: true,
                };
            }
        } else if (uploadExpired && channelId) {
            try {
                const file = await readGifFolderFile(directory, entry.filename);
                expiredUploads.push({
                    file,
                    name: entry.title,
                    manifestKey: entry.key,
                    manifestEntry: isRecord(favorite) ? favorite : undefined,
                    folders: entry.folders,
                    order: isRecord(favorite) && typeof favorite.order === "number"
                        ? favorite.order
                        : entry.index,
                });
            } catch (error) {
                logger.error(`Missing restored GIF file: ${entry.filename}`, error);
            }
        }
        onProgress({
            completed: index + 1,
            total: entries.length,
            phase: "checking",
        });
    }

    if (!manifest) {
        for (const mediaFile of directoryFiles) {
            if (!/^.*\.(gif|avif|webp|jpe?g|png|mp4|webm)$/i.test(mediaFile.name)) continue;
            expiredUploads.push({
                file: mediaFile,
                name: mediaFile.name.replace(/\.[^.]+$/, ""),
                manifestKey: mediaFile.name,
                folders: [],
            });
        }
    }

    onProgress({
        completed: 0,
        total: expiredUploads.length,
        phase: "uploading",
    });
    const uploaded = uploadExpired && channelId
        ? await uploadGifFilesToChannel(
            channelId,
            expiredUploads.map(upload => ({ file: upload.file, name: upload.name })),
            signal,
            completed => onProgress({
                completed,
                total: expiredUploads.length,
                phase: "uploading",
            }),
        )
        : [];

    const library: GifLibraryData = {
        folders: [...new Set(manifestLibrary.folders)],
        assignments: {},
        titleOverrides: {},
        layoutSize: manifestLibrary.layoutSize,
    };

    for (const [index, upload] of uploaded.entries()) {
        const source = expiredUploads[index];
        const key = upload.url;
        restoredFavorites[key] = {
            key,
            keyIsUrl: true,
            url: upload.url,
            src: upload.proxyUrl,
            title: source.name,
            format: /\.(mp4|webm)$/i.test(source.file.name) ? 2 : 1,
            width: positiveDimensionOr32(source.manifestEntry?.width ?? upload.width),
            height: positiveDimensionOr32(source.manifestEntry?.height ?? upload.height),
            order: source.order,
        };
        for (const folder of source.folders) {
            if (!library.folders.includes(folder)) library.folders.push(folder);
        }
        if (source.folders.length) library.assignments[key] = [...source.folders];
        library.titleOverrides[key] = source.name;

        if (source.manifestEntry) {
            const { manifestKey } = source;
            for (const folder of manifestLibrary.assignments[manifestKey] ?? [])
                if (!library.folders.includes(folder)) library.folders.push(folder);
        }
    }

    for (const [key, assignedFolders] of Object.entries(manifestLibrary.assignments)) {
        if (restoredFavorites[key]) {
            library.assignments[key] = [
                ...new Set([...(library.assignments[key] ?? []), ...assignedFolders]),
            ];
        }
    }
    for (const [key, title] of Object.entries(manifestLibrary.titleOverrides)) {
        if (restoredFavorites[key]) library.titleOverrides[key] = title;
    }

    onProgress({
        completed: Object.keys(restoredFavorites).length,
        total: Object.keys(restoredFavorites).length,
        phase: "importing",
    });
    const added = await importGifVaultBackupData({
        version: BACKUP_VERSION,
        favoriteGifs: restoredFavorites,
        library,
    });
    onProgress({
        completed: Object.keys(restoredFavorites).length,
        total: Object.keys(restoredFavorites).length,
        phase: "complete",
    });
    return added;
}

function askAboutExpiredGifUploads() {
    return new Promise<boolean>(resolve => {
        openModal(modalProps => (
            <ConfirmModal
                {...modalProps}
                title="Restore GIFs with expired links?"
                subtitle="GIF Vault found an organization manifest. It can upload locally saved GIFs with expired or unavailable links to Discord, then add them back with their original folders."
                confirmText="Yes, upload and restore"
                cancelText="No, use valid URLs only"
                onConfirm={() => resolve(true)}
                onCloseCallback={() => resolve(false)}
            />
        ));
    });
}

function GifRestoreChannelModal({
    modalProps,
    initialChannelId,
    onProceed,
    onCancel,
}: {
    modalProps: RenderModalProps;
    initialChannelId: string;
    onProceed: (channelId: string) => void;
    onCancel: () => void;
}) {
    const [channelId, setChannelId] = useState(initialChannelId);

    const validChannelId = /^\d{17,20}$/.test(channelId.trim());
    const channel = validChannelId ? ChannelStore.getChannel(channelId.trim()) : undefined;

    return (
        <Modal
            {...modalProps}
            title="Choose an upload channel"
            actions={[
                {
                    text: "Cancel",
                    variant: "secondary",
                    onClick: onCancel,
                },
                {
                    text: "Proceed with restore",
                    variant: "primary",
                    onClick: () => onProceed(channelId.trim()),
                    disabled: !channel,
                },
            ]}
        >
            <div className="vc-gif-vault-backupSettings">
                <Paragraph>
                    Enter the ID of a channel in an empty private server or a DM channel ID
                    (including a bot's DMs, which I'd recommend).
                </Paragraph>
                <Paragraph>
                    GIF Vault will send restore messages containing each uploaded GIF. Never delete the
                    server or channel, and avoid deleting or changing these uploaded messages.
                </Paragraph>
                <Paragraph>
                    You can use <code>/uploadgifshere</code> in a channel first instead of entering
                    an ID here. Run it before opening Restore GIFs from Folder again.
                </Paragraph>
                <Paragraph>
                    Uploading many GIFs may take time and may temporarily trigger Discord
                    rate limits. Try not to send other messages until the restore finishes.
                </Paragraph>
                <TextInput
                    value={channelId}
                    onChange={setChannelId}
                    placeholder="Discord channel ID"
                    aria-label="Discord upload channel ID"
                />
                {validChannelId && !channel && (
                    <Paragraph>
                        This channel was not found. Check the channel ID and make sure Discord can
                        access it.
                    </Paragraph>
                )}
            </div>
        </Modal>
    );
}

function askForGifRestoreChannel(initialChannelId: string) {
    return new Promise<string | undefined>(resolve => {
        openModal(modalProps => (
            <GifRestoreChannelModal
                modalProps={modalProps}
                initialChannelId={initialChannelId}
                onProceed={channelId => {
                    modalProps.onClose();
                    resolve(channelId);
                }}
                onCancel={() => {
                    modalProps.onClose();
                    resolve(undefined);
                }}
            />
        ));
    });
}

const GifVaultBackupSettings = ErrorBoundary.wrap(
    () => {
        const inputRef = useRef<HTMLInputElement>(null);
        const restoreInputRef = useRef<HTMLInputElement>(null);
        const exportAbortRef = useRef<AbortController | null>(null);
        const [busy, setBusy] = useState(false);
        const [exportProgress, setExportProgress] = useState<GifFolderExportProgress>();
        const [restoreProgress, setRestoreProgress] = useState<GifFolderRestoreProgress>();

        useEffect(
            () =>
                subscribeGifExportStatus((progress, active) => {
                    setExportProgress(progress);
                    setBusy(active);
                }),
            [],
        );

        async function exportBackup() {
            setExportProgress(undefined);
            setBusy(true);
            try {
                await exportGifVaultBackup();
                showToast({ text: "GIF Vault backup exported.", variant: "success" });
            } catch (error) {
                logger.error("Failed to export GIF Vault backup", error);
                showToast({ text: "Failed to export the GIF Vault backup.", variant: "critical" });
            } finally {
                setBusy(false);
            }
        }

        async function restoreFromDirectory(directory: GifFolderDirectory) {
            setRestoreProgress({ completed: 0, total: 0, phase: "preparing" });
            setBusy(true);
            const controller = new AbortController();
            exportAbortRef.current = controller;

            try {
                const manifest = await readGifFolderManifest(directory);
                let uploadExpired = false;
                let channelId: string | undefined;

                if (isGifFolderManifest(manifest?.manifest)) {
                    uploadExpired = await askAboutExpiredGifUploads();
                    if (uploadExpired) {
                        const savedChannelId = await DataStore.get<string>(RESTORE_CHANNEL_KEY) ?? "";
                        channelId = await askForGifRestoreChannel(savedChannelId);
                        if (!channelId) {
                            showToast({
                                text: "A Discord upload channel is required. Use /uploadgifshere in a channel or enter a valid channel ID.",
                                variant: "critical",
                            });
                            setRestoreProgress(undefined);
                            return;
                        }
                        await DataStore.set(RESTORE_CHANNEL_KEY, channelId);
                    }
                } else {
                    const savedChannelId = await DataStore.get<string>(RESTORE_CHANNEL_KEY) ?? "";
                    channelId = await askForGifRestoreChannel(savedChannelId);
                    if (!channelId) {
                        showToast({
                            text: "A Discord upload channel is required. Use /uploadgifshere in a channel or enter a valid channel ID.",
                            variant: "critical",
                        });
                        setRestoreProgress(undefined);
                        return;
                    }
                    uploadExpired = true;
                    await DataStore.set(RESTORE_CHANNEL_KEY, channelId);
                }

                const added = await restoreGifFolder(
                    directory,
                    uploadExpired,
                    channelId,
                    controller.signal,
                    setRestoreProgress,
                );
                showToast({
                    text: `GIF Vault folder restored. Added ${added} favorite GIF${added === 1 ? "" : "s"}.`,
                    variant: "success",
                });
            } catch (error) {
                if (error instanceof DOMException && error.name === "AbortError") {
                    setRestoreProgress(progress =>
                        progress ? { ...progress, phase: "cancelled" } : progress,
                    );
                } else {
                    logger.error("Failed to restore GIFs from folder", error);
                    showToast({
                        text: "Failed to restore GIFs from the folder. Check the Vencord console for details.",
                        variant: "critical",
                    });
                    setRestoreProgress(undefined);
                }
            } finally {
                gifExportAbortController = null;
                exportAbortRef.current = null;
            }
        }

        async function restoreGifs() {
            setRestoreProgress(undefined);
            setBusy(true);
            try {
                if (Native) {
                    const folderPath = await Native.selectFolder();
                    if (folderPath) await restoreFromDirectory(folderPath);
                    return;
                }

                const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker;
                if (!picker) {
                    restoreInputRef.current?.click();
                    return;
                }
                const directory = await picker.call(window, { mode: "read" });
                await restoreFromDirectory(directory);
            } catch (error) {
                if (!(error instanceof DOMException && error.name === "AbortError")) {
                    logger.error("Failed to select GIF restore folder", error);
                    showToast({
                        text: "Failed to select the GIF restore folder.",
                        variant: "critical",
                    });
                }
            } finally {
                setBusy(false);
            }
        }

        async function restoreFromSelectedFiles(input: HTMLInputElement) {
            const files = Array.from(input.files ?? []);
            input.value = "";
            if (!files.length) return;

            const manifestFile = files.find(file => file.name === "gif-vault-export.json");
            if (manifestFile) {
                try {
                    const manifest = JSON.parse(await manifestFile.text()) as unknown;
                    if (!isGifFolderManifest(manifest))
                        throw new Error("This is not a supported GIF Vault folder manifest.");
                    showToast({
                        text: "A folder manifest was selected. Please select the containing folder so GIF files can be restored.",
                        variant: "critical",
                    });
                } catch (error) {
                    logger.error("Failed to read selected GIF manifest", error);
                    showToast({
                        text: "The selected manifest could not be read.",
                        variant: "critical",
                    });
                }
                return;
            }

            setBusy(true);
            setRestoreProgress({ completed: 0, total: files.length, phase: "preparing" });
            const savedChannelId = await DataStore.get<string>(RESTORE_CHANNEL_KEY) ?? "";
            const channelId = await askForGifRestoreChannel(savedChannelId);
            if (!channelId) {
                setBusy(false);
                setRestoreProgress(undefined);
                showToast({
                    text: "A Discord upload channel is required. Use /uploadgifshere or enter a valid channel ID.",
                    variant: "critical",
                });
                return;
            }
            await DataStore.set(RESTORE_CHANNEL_KEY, channelId);

            const controller = new AbortController();
            exportAbortRef.current = controller;
            try {
                const uploaded = await uploadGifFilesToChannel(
                    channelId,
                    files.map(file => ({
                        file,
                        name: file.name.replace(/\.[^.]+$/, ""),
                    })),
                    controller.signal,
                    completed => setRestoreProgress({
                        completed,
                        total: files.length,
                        phase: "uploading",
                    }),
                );
                const favoriteGifs: Record<string, Record<string, unknown>> = {};
                for (const upload of uploaded) {
                    favoriteGifs[upload.url] = {
                        key: upload.url,
                        keyIsUrl: true,
                        url: upload.url,
                        src: upload.proxyUrl,
                        title: upload.name,
                        format: /\.(mp4|webm)$/i.test(upload.file.name) ? 2 : 1,
                        width: positiveDimensionOr32(upload.width),
                        height: positiveDimensionOr32(upload.height),
                    };
                }
                const added = await importGifVaultBackupData({
                    version: BACKUP_VERSION,
                    favoriteGifs,
                    library: EMPTY_LIBRARY,
                });
                setRestoreProgress({
                    completed: files.length,
                    total: files.length,
                    phase: "complete",
                });
                showToast({
                    text: `GIFs restored. Added ${added} favorite GIF${added === 1 ? "" : "s"}.`,
                    variant: "success",
                });
            } catch (error) {
                logger.error("Failed to restore selected GIF files", error);
                showToast({
                    text: "Failed to restore the selected GIF files.",
                    variant: "critical",
                });
                setRestoreProgress(undefined);
            } finally {
                exportAbortRef.current = null;
                if (gifExportAbortController === controller)
                    gifExportAbortController = null;
            }
        }

        async function downloadAllGifs() {
            updateGifExportStatus({ completed: 0, total: 0, phase: "preparing" }, true);
            const controller = new AbortController();
            gifExportAbortController = controller;
            exportAbortRef.current = gifExportAbortController;
            try {
                if (Native) {
                    const folderPath = await Native.selectFolder();
                    if (!folderPath) {
                        updateGifExportStatus(undefined, false);
                        return;
                    }
                    const failedCount = await exportFavoriteGifsToNativeFolder(
                        folderPath,
                        controller.signal,
                        progress => updateGifExportStatus(progress, true),
                    );
                    updateGifExportStatus(
                        {
                            ...(gifExportProgress ?? {
                                completed: 0,
                                total: 0,
                                phase: "complete",
                            }),
                            phase: "complete",
                            failed: failedCount,
                        },
                        false,
                    );
                    showToast({
                        text: "Favorite GIFs exported to the selected folder.",
                        variant: "success",
                    });
                    return;
                }

                const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker;
                if (!picker)
                    throw new Error("Folder export requires a browser with folder access support.");

                const directory = await picker.call(window, { mode: "readwrite" });
                const permissionHandle = directory as FileSystemDirectoryHandleWithPermission;
                if (typeof permissionHandle.requestPermission === "function") {
                    const permission = await permissionHandle.requestPermission({ mode: "readwrite" });
                    if (permission !== "granted")
                        throw new DOMException("Folder write permission was not granted.", "NotAllowedError");
                }
                const failedCount = await exportFavoriteGifsToFolder(
                    directory,
                    controller.signal,
                    progress => updateGifExportStatus(progress, true),
                );
                updateGifExportStatus({
                    ...(gifExportProgress ?? {
                        completed: 0,
                        total: 0,
                        phase: "complete",
                    }),
                    phase: "complete",
                    failed: failedCount,
                }, false);
                showToast({
                    text: failedCount
                        ? `Favorite GIF folder export completed with ${failedCount} unavailable GIF${failedCount === 1 ? "" : "s"}.`
                        : "Favorite GIFs exported to the selected folder.",
                    variant: "success",
                });
            } catch (error) {
                if (error instanceof DOMException && error.name === "AbortError") {
                    if (controller.signal.aborted) {
                        updateGifExportStatus(
                            gifExportProgress
                                ? { ...gifExportProgress, phase: "cancelled" }
                                : undefined,
                            false,
                        );
                    } else {
                        updateGifExportStatus(undefined, false);
                    }
                } else {
                    logger.error("Failed to download favorite GIFs", error);
                    const message =
                        error instanceof Error ? error.message : "Unknown folder export error";
                    updateGifExportStatus({
                        completed: 0,
                        total: 0,
                        phase: "error",
                    }, false);
                    showToast({
                        text: `Failed to download favorite GIFs: ${message}`,
                        variant: "critical",
                    });
                }
            } finally {
                exportAbortRef.current = null;
                setBusy(false);
            }
        }

        async function importBackup(input: HTMLInputElement) {
            const file = input.files?.[0];
            input.value = "";
            if (!file) return;

            setExportProgress(undefined);
            setBusy(true);
            try {
                const count = await importGifVaultBackup(file);
                showToast({
                    text: `GIF Vault backup imported. Added ${count} favorite GIF${count === 1 ? "" : "s"} where missing.`,
                    variant: "success",
                });
            } catch (error) {
                logger.error("Failed to import GIF Vault backup", error);
                showToast({
                    text: "Failed to import the GIF Vault backup. Check the Vencord console for details.",
                    variant: "critical",
                });
            } finally {
                setBusy(false);
            }
        }

        return (
            <div className="vc-gif-vault-backupSettings">
                <Paragraph>
                    Export a backup of your favorite GIFs and folder organization, or merge one into
                    this Discord account. Download all GIFs saves the media and a reimport-ready
                    organization manifest in a selected folder.
                </Paragraph>
                <div className="vc-gif-vault-backupActions">
                    <Button variant="secondary" onClick={exportBackup} disabled={busy}>
                        Export GIF Vault
                    </Button>
                    <Button variant="secondary" onClick={downloadAllGifs} disabled={busy}>
                        Download all GIFs
                    </Button>
                    <Button variant="secondary" onClick={restoreGifs} disabled={busy}>
                        Restore GIFs from Folder
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={() => inputRef.current?.click()}
                        disabled={busy}
                    >
                        Import GIF Vault
                    </Button>
                    <input
                        ref={inputRef}
                        type="file"
                        accept="application/json,.json"
                        hidden
                        onChange={event => void importBackup(event.currentTarget)}
                    />
                    <input
                        ref={restoreInputRef}
                        type="file"
                        accept=".json,.gif,.avif,.webp,.jpg,.jpeg,.png,.mp4,.webm"
                        hidden
                        onChange={event => void restoreFromSelectedFiles(event.currentTarget)}
                    />
                </div>
                {exportProgress && (
                    <div className="vc-gif-vault-exportProgress">
                        <progress
                            max={exportProgress.total || 1}
                            value={exportProgress.completed}
                            aria-label="GIF download progress"
                        />
                        <span>
                            {exportProgress.phase === "preparing"
                                ? "Preparing folder export…"
                                : exportProgress.phase === "manifest"
                                    ? "Writing organization data…"
                                    : exportProgress.phase === "complete"
                                        ? exportProgress.failed
                                            ? `Downloaded ${exportProgress.completed - exportProgress.failed} GIF${exportProgress.completed - exportProgress.failed === 1 ? "" : "s"}; ${exportProgress.failed} unavailable.`
                                            : `Downloaded ${exportProgress.total} GIF${exportProgress.total === 1 ? "" : "s"}.`
                                        : exportProgress.phase === "cancelled"
                                            ? `Cancelled after ${exportProgress.completed} of ${exportProgress.total} GIFs.`
                                            : exportProgress.phase === "error"
                                                ? "Folder export failed."
                                                : `Downloading ${exportProgress.completed} of ${exportProgress.total} GIFs…`}
                        </span>
                        {(exportProgress.phase === "preparing" ||
                            exportProgress.phase === "downloading" ||
                            exportProgress.phase === "manifest") && (
                                <Button
                                    variant="secondary"
                                    onClick={() => gifExportAbortController?.abort()}
                                >
                                    Cancel
                                </Button>
                            )}
                    </div>
                )}
                {restoreProgress && (
                    <div className="vc-gif-vault-exportProgress">
                        <progress
                            max={restoreProgress.total || 1}
                            value={restoreProgress.completed}
                            aria-label="GIF restore progress"
                        />
                        <span>
                            {restoreProgress.phase === "preparing"
                                ? "Preparing folder restore…"
                                : restoreProgress.phase === "checking"
                                    ? `Checking links ${restoreProgress.completed} of ${restoreProgress.total}…`
                                    : restoreProgress.phase === "uploading"
                                        ? `Uploading ${restoreProgress.completed} of ${restoreProgress.total} GIFs…`
                                        : restoreProgress.phase === "importing"
                                            ? "Saving favorites and folders…"
                                            : restoreProgress.phase === "cancelled"
                                                ? "Restore cancelled."
                                                : `Restored ${restoreProgress.completed} of ${restoreProgress.total} GIFs.`}
                        </span>
                        {(restoreProgress.phase === "preparing" ||
                            restoreProgress.phase === "checking" ||
                            restoreProgress.phase === "uploading" ||
                            restoreProgress.phase === "importing") && (
                                <Button
                                    variant="secondary"
                                    onClick={() => exportAbortRef.current?.abort()}
                                >
                                    Cancel
                                </Button>
                            )}
                    </div>
                )}
            </div>
        );
    },
    { noop: true },
);

function openGifVault() {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

    openModal(modalProps => <SafeGifVaultModal channelId={channelId} modalProps={modalProps} />);
}

function GifPreview({
    gif,
    compact = false,
    resolveGifSrc = false,
}: {
    gif: FavoriteGif;
    compact?: boolean;
    resolveGifSrc?: boolean;
}) {
    const [imageUrl, setImageUrl] = useState(gif.previewUrl);

    useEffect(() => {
        let cancelled = false;
        setImageUrl(gif.previewUrl);
        if (!resolveGifSrc || !gif.gifSrc) return;

        Promise.resolve()
            .then(() => gif.gifSrc!())
            .then(value => {
                const url = httpUrl(value);
                if (!cancelled && url) setImageUrl(url);
            })
            .catch(error => logger.error("Failed to resolve a favorite GIF preview", error));

        return () => {
            cancelled = true;
        };
    }, [gif, resolveGifSrc]);

    return (
        <img
            className={
                compact
                    ? "vc-gif-vault-preview vc-gif-vault-previewCompact"
                    : "vc-gif-vault-preview"
            }
            src={imageUrl}
            alt={gif.title}
            loading="lazy"
        />
    );
}

function GifVaultCard({
    gif,
    assignedFolders,
    folders,
    selected,
    saving,
    editing,
    titleDraft,
    onPreview,
    onToggleFolder,
    onTitleDraftChange,
    onStartRename,
    onSaveRename,
    onCancelRename,
    onDelete,
}: {
    gif: FavoriteGif;
    assignedFolders: string[];
    folders: string[];
    selected: boolean;
    saving: boolean;
    editing: boolean;
    titleDraft: string;
    onPreview(): void;
    onToggleFolder(folder: string): void;
    onTitleDraftChange(value: string): void;
    onStartRename(): void;
    onSaveRename(): void;
    onCancelRename(): void;
    onDelete(): void;
}) {
    return (
        <article className="vc-gif-vault-card">
            <button
                type="button"
                className={`vc-gif-vault-cardPreview${selected ? " vc-gif-vault-cardSelected" : ""}`}
                onClick={onPreview}
                aria-label={`Preview ${gif.title} above`}
                aria-pressed={selected}
            >
                <GifPreview gif={gif} compact />
            </button>
            <div className="vc-gif-vault-cardTitleRow">
                {editing ? (
                    <>
                        <TextInput
                            value={titleDraft}
                            onChange={onTitleDraftChange}
                            placeholder="GIF title"
                            maxLength={100}
                            inputClassName="vc-gif-vault-titleInput"
                        />
                        <button
                            type="button"
                            className="vc-gif-vault-cardAction"
                            aria-label={`Save ${gif.title} title`}
                            title="Save title"
                            onClick={onSaveRename}
                            disabled={!titleDraft.trim() || saving}
                        >
                            ✓
                        </button>
                        <button
                            type="button"
                            className="vc-gif-vault-cardAction"
                            aria-label="Cancel GIF rename"
                            title="Cancel"
                            onClick={onCancelRename}
                            disabled={saving}
                        >
                            ×
                        </button>
                    </>
                ) : (
                    <>
                        <span className="vc-gif-vault-cardTitle" title={gif.title}>
                            {gif.title}
                        </span>
                        <button
                            type="button"
                            className="vc-gif-vault-cardAction"
                            aria-label={`Rename ${gif.title}`}
                            title={`Rename ${gif.title}`}
                            onClick={onStartRename}
                            disabled={saving}
                        >
                            ✎
                        </button>
                        <button
                            type="button"
                            className="vc-gif-vault-cardAction vc-gif-vault-cardDelete"
                            aria-label={`Remove ${gif.title} from favorites`}
                            title="Remove from favorites"
                            onClick={onDelete}
                            disabled={saving}
                        >
                            ×
                        </button>
                    </>
                )}
            </div>
            <div
                className="vc-gif-vault-folderSelectWrapper"
                title={assignedFolders.length ? assignedFolders.join(", ") : UNFILED}
            >
                <SearchableSelect
                    className="vc-gif-vault-folderSelect"
                    placeholder={assignedFolders.length ? assignedFolders.join(", ") : UNFILED}
                    options={[
                        { label: UNFILED, value: "" },
                        ...folders.map(folder => ({
                            label: folder,
                            value: folder,
                        })),
                    ]}
                    value={null}
                    onChange={value => {
                        const folder = selectedFolderValue(value);
                        if (folder !== undefined) onToggleFolder(folder);
                    }}
                    renderOptionPrefix={option =>
                        assignedFolders.includes(option.value) ? (
                            <span className="vc-gif-vault-folderOptionSelected">✓</span>
                        ) : null
                    }
                    closeOnSelect
                    isDisabled={saving}
                    maxVisibleItems={6}
                />
            </div>
        </article>
    );
}

function GifVaultModal({
    channelId,
    modalProps,
}: {
    channelId: string;
    modalProps: RenderModalProps;
}) {
    const favoriteGifs = useStateFromStores([UserSettingsProtoStore], getFavorites);
    const pendingReply = useStateFromStores([PendingReplyStore], () =>
        PendingReplyStore.getPendingReply(channelId),
    );
    const [library, setLibrary] = useState<GifLibraryData>(EMPTY_LIBRARY);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [search, setSearch] = useState("");
    const [folderFilter, setFolderFilter] = useState("");
    const [sortOrder, setSortOrder] = useState<GifSortOrder>("added-newest");
    const [maximized, setMaximized] = useState(false);
    const [newFolder, setNewFolder] = useState("");
    const [editingFolder, setEditingFolder] = useState<string>();
    const [folderNameDraft, setFolderNameDraft] = useState("");
    const [editingGifKey, setEditingGifKey] = useState<string>();
    const [gifTitleDraft, setGifTitleDraft] = useState("");
    const [randomGif, setRandomGif] = useState<FavoriteGif>();
    const [saving, setSaving] = useState(false);
    const [columns, setColumns] = useState(5);
    const [gridHeight, setGridHeight] = useState(0);
    const gridRef = useRef<HTMLDivElement>(null);
    const vaultRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!maximized) return;

        const modalContent = vaultRef.current?.parentElement;
        if (!modalContent) return;

        const maxWidth = window.innerWidth * 0.95;
        const maxHeight = window.innerHeight * 0.95;
        const originalStyles = new Map<
            HTMLElement,
            Map<string, { value: string; priority: string; }>
        >();
        for (
            let element: HTMLElement | null = modalContent;
            element && element !== document.body;
            element = element.parentElement
        ) {
            const bounds = element.getBoundingClientRect();
            const resizeWidth = bounds.width < maxWidth;
            const resizeHeight = bounds.height < maxHeight;
            if (!resizeWidth && !resizeHeight) continue;

            const properties = [
                ...(resizeWidth ? ["width", "max-width"] : []),
                ...(resizeHeight ? ["height", "max-height"] : []),
            ];
            originalStyles.set(
                element,
                new Map(
                    properties.map(property => [
                        property,
                        {
                            value: element.style.getPropertyValue(property),
                            priority: element.style.getPropertyPriority(property),
                        },
                    ]),
                ),
            );
            if (resizeWidth) {
                element.style.setProperty("width", "95vw", "important");
                element.style.setProperty("max-width", "95vw", "important");
            }
            if (resizeHeight) {
                element.style.setProperty("height", "95vh", "important");
                element.style.setProperty("max-height", "95vh", "important");
            }
        }

        return () => {
            for (const [element, styles] of originalStyles) {
                for (const [property, { value, priority }] of styles) {
                    if (value) element.style.setProperty(property, value, priority);
                    else element.style.removeProperty(property);
                }
            }
        };
    }, [maximized]);

    useEffect(() => {
        let cancelled = false;
        DataStore.get<unknown>(DATA_KEY)
            .then(value => {
                if (cancelled) return;
                setLibrary(readLibraryData(value));
                setLoaded(true);
            })
            .catch(error => {
                logger.error("Failed to load GIF folder data", error);
                if (cancelled) return;
                setLoadError(true);
                setLoaded(true);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (favoriteGifs.length === 0) {
            setRandomGif(undefined);
        } else if (!randomGif || !favoriteGifs.some(gif => gif.key === randomGif.key)) {
            setRandomGif(favoriteGifs[Math.floor(Math.random() * favoriteGifs.length)]);
        }
    }, [favoriteGifs, randomGif]);

    const titledGifs = useMemo(
        () =>
            favoriteGifs.map(gif => ({
                ...gif,
                title: library.titleOverrides[gif.key] ?? gif.title,
            })),
        [favoriteGifs, library.titleOverrides],
    );
    const filteredGifs = useMemo(() => {
        const query = search.trim().toLocaleLowerCase();
        const filtered = titledGifs.filter(gif => {
            const assignedFolders = library.assignments[gif.key] ?? [];
            const matchesFolder =
                !folderFilter ||
                (folderFilter === UNFILED
                    ? assignedFolders.length === 0
                    : assignedFolders.includes(folderFilter));
            const matchesSearch =
                !query || `${gif.title} ${gif.url}`.toLocaleLowerCase().includes(query);
            return matchesFolder && matchesSearch;
        });
        if (sortOrder === "added-newest") return filtered.reverse();
        if (sortOrder === "added-oldest") return filtered;

        return filtered.sort((a, b) =>
            sortOrder === "title-asc"
                ? a.title.localeCompare(b.title, undefined, {
                    numeric: true,
                    sensitivity: "base",
                })
                : b.title.localeCompare(a.title, undefined, {
                    numeric: true,
                    sensitivity: "base",
                }),
        );
    }, [folderFilter, library.assignments, search, sortOrder, titledGifs]);
    const gifRows = useMemo(() => {
        const rows: FavoriteGif[][] = [];
        for (let i = 0; i < filteredGifs.length; i += columns)
            rows.push(filteredGifs.slice(i, i + columns));
        return rows;
    }, [columns, filteredGifs]);
    const folderCounts = useMemo(() => {
        const counts = new Map<string, number>([[UNFILED, 0]]);
        for (const gif of favoriteGifs) {
            const folders = library.assignments[gif.key] ?? [];
            if (!folders.length) counts.set(UNFILED, (counts.get(UNFILED) ?? 0) + 1);
            else {
                for (const folder of folders) counts.set(folder, (counts.get(folder) ?? 0) + 1);
            }
        }
        return counts;
    }, [favoriteGifs, library.assignments]);
    const tileSize = TILE_SIZES[library.layoutSize];

    useEffect(() => {
        const node = gridRef.current;
        if (!node) return;

        const observer = new ResizeObserver(() => {
            const nextHeight = node.clientHeight;
            setGridHeight(current => (current === nextHeight ? current : nextHeight));

            const nextColumns =
                library.layoutSize === "large" && !maximized
                    ? 2
                    : Math.max(
                        1,
                        Math.min(
                            5,
                            Math.floor(
                                (node.clientWidth + 12) /
                                (tileSize.minWidth * (maximized ? 1.5 : 1) + 12),
                            ),
                        ),
                    );
            setColumns(current => (current === nextColumns ? current : nextColumns));
        });
        observer.observe(node);

        return () => observer.disconnect();
    }, [loaded, filteredGifs.length > 0, library.layoutSize, maximized]);
    const rowHeight = maximized
        ? Math.min(tileSize.rowHeight * 1.5, gridHeight || tileSize.rowHeight * 1.5)
        : tileSize.rowHeight;

    async function saveLibrary(next: GifLibraryData) {
        setSaving(true);
        try {
            await DataStore.set(DATA_KEY, next);
            setLibrary(next);
        } catch (error) {
            logger.error("Failed to save GIF Vault library data", error);
            setLoadError(true);
        } finally {
            setSaving(false);
        }
    }

    function rollRandom() {
        if (favoriteGifs.length === 0) return;
        const candidates =
            favoriteGifs.length > 1 && randomGif
                ? favoriteGifs.filter(gif => gif.key !== randomGif.key)
                : favoriteGifs;
        setRandomGif(candidates[Math.floor(Math.random() * candidates.length)]);
    }

    async function sendRandomGif() {
        if (!randomGif) return;
        try {
            const reply = PendingReplyStore.getPendingReply(channelId);
            await sendMessage(
                channelId,
                { content: await getGifUrl(randomGif) },
                false,
                MessageActions.getSendMessageOptionsForReply(reply),
            );
            if (reply) FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });
            modalProps.onClose();
        } catch (error) {
            logger.error("Failed to send a favorite GIF", error);
            showToast({
                text: "Failed to send the GIF. Check the Vencord console for details.",
                variant: "critical",
            });
        }
    }

    async function openFullscreenPreview(gif: FavoriteGif) {
        try {
            const url = await getGifUrl(gif);
            openMediaModal({
                items: [
                    {
                        type: gif.format === 2 ? "VIDEO" : "IMAGE",
                        url,
                        original: url,
                        alt: gif.title,
                        width: gif.width ?? 800,
                        height: gif.height ?? 600,
                        animated: gif.format === 2,
                    },
                ],
            });
        } catch (error) {
            logger.error("Failed to open a favorite GIF preview", error);
            showToast({
                text: "Failed to open the GIF preview. Check the Vencord console for details.",
                variant: "critical",
            });
        }
    }

    function assignFolders(gifKey: string, folders: string[]) {
        const assignments = { ...library.assignments };
        const uniqueFolders = [
            ...new Set(folders.filter(folder => library.folders.includes(folder))),
        ];
        if (uniqueFolders.length) assignments[gifKey] = uniqueFolders;
        else delete assignments[gifKey];
        void saveLibrary({ ...library, assignments });
    }

    function saveGifTitle(gifKey: string) {
        const title = gifTitleDraft.trim();
        if (!title) return;

        const originalTitle = favoriteGifs.find(gif => gif.key === gifKey)?.title;
        const titleOverrides = { ...library.titleOverrides };
        if (title === originalTitle) delete titleOverrides[gifKey];
        else titleOverrides[gifKey] = title;

        void saveLibrary({ ...library, titleOverrides });
        setEditingGifKey(undefined);
        setGifTitleDraft("");
    }

    async function removeFavorite(gif: FavoriteGif) {
        setSaving(true);
        try {
            await UserSettingsActionCreators.FrecencyUserSettingsActionCreators.updateAsync(
                "favoriteGifs",
                current => {
                    if (!isRecord(current) || !isRecord(current.gifs))
                        throw new Error("Discord's favorite GIF settings are unavailable.");
                    delete current.gifs[gif.key];
                },
                0,
            );
        } catch (error) {
            logger.error("Failed to remove a favorite GIF", error);
            showToast({
                text: "Failed to remove the GIF from favorites. Check the Vencord console for details.",
                variant: "critical",
            });
            setSaving(false);
            return;
        }

        const assignments = { ...library.assignments };
        const titleOverrides = { ...library.titleOverrides };
        delete assignments[gif.key];
        delete titleOverrides[gif.key];
        const nextLibrary = { ...library, assignments, titleOverrides };
        try {
            await DataStore.set(DATA_KEY, nextLibrary);
            setLibrary(nextLibrary);
            showToast({ text: "GIF removed from favorites.", variant: "success" });
        } catch (error) {
            logger.error(
                "Removed a favorite GIF but failed to clear its GIF Vault metadata",
                error,
            );
            setLoadError(true);
            showToast({
                text: "The GIF was removed from favorites, but its GIF Vault data could not be cleared.",
                variant: "critical",
            });
        } finally {
            setSaving(false);
            if (editingGifKey === gif.key) {
                setEditingGifKey(undefined);
                setGifTitleDraft("");
            }
        }
    }

    function confirmRemoveFavorite(gif: FavoriteGif) {
        void confirmAction({
            title: `Remove ${gif.title} from favorites?`,
            subtitle: "This removes the GIF from your Discord favorites and cannot be undone here.",
            confirmText: "Remove favorite",
            onConfirm: () => removeFavorite(gif),
        }).catch(error => {
            logger.error("Failed to confirm favorite GIF removal", error);
            showToast({
                text: "Failed to remove the GIF from favorites. Check the Vencord console for details.",
                variant: "critical",
            });
        });
    }

    function createFolder() {
        const name = newFolder.trim();
        if (
            !name ||
            name.toLocaleLowerCase() === UNFILED.toLocaleLowerCase() ||
            library.folders.some(
                folder => folder.toLocaleLowerCase() === name.toLocaleLowerCase(),
            )
        )
            return;
        void saveLibrary({ ...library, folders: [...library.folders, name] });
        setNewFolder("");
    }

    function deleteFolder(name: string) {
        const assignments: Record<string, string[]> = {};
        for (const [gifKey, folders] of Object.entries(library.assignments)) {
            const remaining = folders.filter(folder => folder !== name);
            if (remaining.length) assignments[gifKey] = remaining;
        }
        void saveLibrary({
            ...library,
            folders: library.folders.filter(folder => folder !== name),
            assignments,
        });
        if (folderFilter === name) setFolderFilter("");
    }

    function beginRenameFolder(name: string) {
        setEditingFolder(name);
        setFolderNameDraft(name);
    }

    function renameFolder(oldName: string) {
        const newName = folderNameDraft.trim();
        if (
            !newName ||
            newName.toLocaleLowerCase() === UNFILED.toLocaleLowerCase() ||
            library.folders.some(
                folder =>
                    folder !== oldName &&
                    folder.toLocaleLowerCase() === newName.toLocaleLowerCase(),
            )
        )
            return;

        const assignments = Object.fromEntries(
            Object.entries(library.assignments).map(([gifKey, folders]) => [
                gifKey,
                folders.map(folder => (folder === oldName ? newName : folder)),
            ]),
        );
        void saveLibrary({
            ...library,
            folders: library.folders.map(folder => (folder === oldName ? newName : folder)),
            assignments,
        });
        if (folderFilter === oldName) setFolderFilter(newName);
        setEditingFolder(undefined);
        setFolderNameDraft("");
    }

    const newFolderName = newFolder.trim().toLocaleLowerCase();
    const canCreateFolder =
        newFolderName &&
        newFolderName !== UNFILED.toLocaleLowerCase() &&
        !library.folders.some(folder => folder.toLocaleLowerCase() === newFolderName);
    const canRenameFolder =
        folderNameDraft.trim() &&
        folderNameDraft.trim().toLocaleLowerCase() !== UNFILED.toLocaleLowerCase() &&
        !library.folders.some(
            folder =>
                folder !== editingFolder &&
                folder.toLocaleLowerCase() === folderNameDraft.trim().toLocaleLowerCase(),
        );
    const chunkSize = Math.max(1, Math.ceil(18 / columns));
    const randomDisplayGif = randomGif
        ? (titledGifs.find(gif => gif.key === randomGif.key) ?? randomGif)
        : undefined;
    return (
        <Modal
            {...modalProps}
            title={
                <div className="vc-gif-vault-modalTitle">
                    <span>GIF Vault</span>
                    <button
                        type="button"
                        className="vc-gif-vault-maximizeButton"
                        aria-label={maximized ? "Restore GIF Vault size" : "Maximize GIF Vault"}
                        aria-pressed={maximized}
                        onClick={() => setMaximized(value => !value)}
                    >
                        {maximized ? "Restore" : "Maximize"}
                    </button>
                </div>
            }
            size={maximized ? "xxl" : "xl"}
            actions={[{ text: "Done", variant: "secondary", onClick: modalProps.onClose }]}
        >
            <div
                ref={vaultRef}
                className={`vc-gif-vault vc-gif-vault-${library.layoutSize}${maximized ? " vc-gif-vault-maximized" : ""}`}
            >
                {loadError && (
                    <div className="vc-gif-vault-notice" role="alert">
                        Some GIF Vault data could not be loaded or saved. Check the Vencord console
                        for details.
                    </div>
                )}

                <section className="vc-gif-vault-random">
                    <div className="vc-gif-vault-randomPreview">
                        {randomDisplayGif ? (
                            <button
                                type="button"
                                className="vc-gif-vault-fullscreenPreview"
                                aria-label={`View ${randomDisplayGif.title} fullscreen`}
                                title="View fullscreen"
                                onClick={() => void openFullscreenPreview(randomDisplayGif)}
                            >
                                <GifPreview gif={randomDisplayGif} resolveGifSrc />
                            </button>
                        ) : (
                            <div className="vc-gif-vault-previewPlaceholder" aria-hidden="true">
                                GIF
                            </div>
                        )}
                        <div className="vc-gif-vault-randomInfo">
                            <h3>Random GIF</h3>
                            {randomDisplayGif ? (
                                <>
                                    <strong>{randomDisplayGif.title}</strong>
                                    <span className="vc-gif-vault-folderLabel">
                                        {library.assignments[randomDisplayGif.key]?.join(", ") ||
                                            UNFILED}
                                    </span>
                                </>
                            ) : (
                                <span className="vc-gif-vault-empty">
                                    {favoriteGifs.length
                                        ? "Pick a favorite to preview."
                                        : "Favorite some GIFs in Discord to get started."}
                                </span>
                            )}
                            <div className="vc-gif-vault-actions">
                                <Button
                                    variant="secondary"
                                    onClick={rollRandom}
                                    disabled={!favoriteGifs.length}
                                >
                                    {randomDisplayGif ? "Reroll" : "Pick a favorite"}
                                </Button>
                                <Button
                                    variant="primary"
                                    onClick={sendRandomGif}
                                    disabled={!randomGif}
                                >
                                    {pendingReply ? "Send as reply" : "Send to chat"}
                                </Button>
                            </div>
                        </div>
                    </div>
                </section>

                <section className="vc-gif-vault-library">
                    <div className="vc-gif-vault-libraryHeading">
                        <div>
                            <h3>Your favorites</h3>
                            <span>
                                {favoriteGifs.length} GIF{favoriteGifs.length === 1 ? "" : "s"}{" "}
                                saved in Discord
                            </span>
                        </div>
                        <div className="vc-gif-vault-libraryActions">
                            <div
                                className="vc-gif-vault-layoutOptions"
                                role="group"
                                aria-label="GIF tile size"
                            >
                                {(Object.keys(TILE_SIZES) as GifTileSize[]).map(size => (
                                    <button
                                        key={size}
                                        type="button"
                                        className={
                                            library.layoutSize === size
                                                ? "vc-gif-vault-layoutSelected"
                                                : ""
                                        }
                                        aria-pressed={library.layoutSize === size}
                                        title={`${TILE_SIZES[size].label} GIF tiles`}
                                        onClick={() =>
                                            void saveLibrary({ ...library, layoutSize: size })
                                        }
                                        disabled={saving}
                                    >
                                        {TILE_SIZES[size].label}
                                    </button>
                                ))}
                            </div>
                            <div className="vc-gif-vault-createFolder">
                                <TextInput
                                    value={newFolder}
                                    onChange={setNewFolder}
                                    placeholder="New folder name"
                                    maxLength={32}
                                />
                                <Button
                                    variant="secondary"
                                    onClick={createFolder}
                                    disabled={!canCreateFolder || saving}
                                >
                                    Add folder
                                </Button>
                            </div>
                        </div>
                    </div>
                    <div className="vc-gif-vault-libraryTools">
                        <TextInput
                            value={search}
                            onChange={setSearch}
                            placeholder="Search by title or source"
                            aria-label="Search favorite GIFs"
                        />
                        <div className="vc-gif-vault-sortWrapper">
                            <SearchableSelect
                                className="vc-gif-vault-sort"
                                value={sortOrder}
                                placeholder="Sort favorites"
                                options={[
                                    { label: "Newest added", value: "added-newest" },
                                    { label: "Oldest added", value: "added-oldest" },
                                    { label: "Title A–Z", value: "title-asc" },
                                    { label: "Title Z–A", value: "title-desc" },
                                ]}
                                onChange={value => {
                                    if (typeof value === "string" && isGifSortOrder(value))
                                        setSortOrder(value);
                                }}
                                closeOnSelect
                                maxVisibleItems={4}
                            />
                        </div>
                        <span className="vc-gif-vault-count">
                            {filteredGifs.length} GIF{filteredGifs.length === 1 ? "" : "s"}
                        </span>
                    </div>
                    <ScrollerThin
                        className="vc-gif-vault-folderTabs"
                        orientation="horizontal"
                        fade={false}
                    >
                        <div
                            className="vc-gif-vault-folderTabList"
                            aria-label="Filter GIFs by folder"
                        >
                            {[
                                { label: "All", value: "", count: favoriteGifs.length },
                                {
                                    label: UNFILED,
                                    value: UNFILED,
                                    count: folderCounts.get(UNFILED) ?? 0,
                                },
                                ...library.folders.map(folder => ({
                                    label: folder,
                                    value: folder,
                                    count: folderCounts.get(folder) ?? 0,
                                })),
                            ].map(folder => (
                                <div
                                    key={folder.value || "all"}
                                    className={`vc-gif-vault-folderTab${folderFilter === folder.value ? " vc-gif-vault-folderTabSelected" : ""}`}
                                >
                                    <button
                                        type="button"
                                        onClick={() => setFolderFilter(folder.value)}
                                        aria-pressed={folderFilter === folder.value}
                                        title={`Show ${folder.label} GIFs`}
                                    >
                                        <span>{folder.label}</span>
                                        <span className="vc-gif-vault-folderCount">
                                            {folder.count}
                                        </span>
                                    </button>
                                    {library.folders.includes(folder.value) &&
                                        (editingFolder === folder.value ? (
                                            <>
                                                <TextInput
                                                    value={folderNameDraft}
                                                    onChange={setFolderNameDraft}
                                                    placeholder="Folder name"
                                                    maxLength={32}
                                                    inputClassName="vc-gif-vault-renameInput"
                                                />
                                                <button
                                                    type="button"
                                                    className="vc-gif-vault-folderAction"
                                                    aria-label={`Save ${folder.label} folder name`}
                                                    onClick={() => renameFolder(folder.value)}
                                                    disabled={!canRenameFolder || saving}
                                                >
                                                    ✓
                                                </button>
                                                <button
                                                    type="button"
                                                    className="vc-gif-vault-folderAction"
                                                    aria-label="Cancel folder rename"
                                                    onClick={() => setEditingFolder(undefined)}
                                                    disabled={saving}
                                                >
                                                    ×
                                                </button>
                                            </>
                                        ) : (
                                            <button
                                                type="button"
                                                className="vc-gif-vault-folderAction"
                                                aria-label={`Rename ${folder.label} folder`}
                                                title={`Rename ${folder.label}`}
                                                onClick={() => beginRenameFolder(folder.value)}
                                                disabled={saving}
                                            >
                                                ✎
                                            </button>
                                        ))}
                                    {library.folders.includes(folder.value) && (
                                        <button
                                            type="button"
                                            className="vc-gif-vault-deleteFolder"
                                            aria-label={`Delete ${folder.label} folder`}
                                            title={`Delete ${folder.label} folder`}
                                            onClick={() => deleteFolder(folder.value)}
                                            disabled={saving}
                                        >
                                            ×
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    </ScrollerThin>

                    {!loaded ? (
                        <p className="vc-gif-vault-empty">Loading your GIF folders…</p>
                    ) : filteredGifs.length ? (
                        <div className="vc-gif-vault-gridScroller" ref={gridRef}>
                            <ListScrollerThin
                                key={sortOrder}
                                className="vc-gif-vault-gridScrollerInner"
                                innerClassName="vc-gif-vault-gridContent"
                                sections={[gifRows.length]}
                                sectionHeight={0}
                                rowHeight={rowHeight}
                                chunkSize={chunkSize}
                                paddingTop={0}
                                paddingBottom={0}
                                style={{ overflowAnchor: "none" }}
                                getAnchorId={({ section, row }) => `${section}:${row}`}
                                renderSection={() => null}
                                renderRow={({ row }) => (
                                    <div
                                        key={`gif-row-${row}`}
                                        className="vc-gif-vault-gridRow"
                                        style={{
                                            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                                            height: maximized ? rowHeight : undefined,
                                        }}
                                    >
                                        {gifRows[row].map(gif => (
                                            <GifVaultCard
                                                key={gif.key}
                                                gif={gif}
                                                assignedFolders={library.assignments[gif.key] ?? []}
                                                folders={library.folders}
                                                selected={randomGif?.key === gif.key}
                                                saving={saving}
                                                editing={editingGifKey === gif.key}
                                                titleDraft={gifTitleDraft}
                                                onPreview={() => setRandomGif(gif)}
                                                onToggleFolder={folder => {
                                                    const assigned =
                                                        library.assignments[gif.key] ?? [];
                                                    assignFolders(
                                                        gif.key,
                                                        folder === ""
                                                            ? []
                                                            : assigned.includes(folder)
                                                                ? assigned.filter(
                                                                    name => name !== folder,
                                                                )
                                                                : [...assigned, folder],
                                                    );
                                                }}
                                                onTitleDraftChange={setGifTitleDraft}
                                                onStartRename={() => {
                                                    setEditingGifKey(gif.key);
                                                    setGifTitleDraft(gif.title);
                                                }}
                                                onSaveRename={() => saveGifTitle(gif.key)}
                                                onCancelRename={() => {
                                                    setEditingGifKey(undefined);
                                                    setGifTitleDraft("");
                                                }}
                                                onDelete={() => confirmRemoveFavorite(gif)}
                                            />
                                        ))}
                                    </div>
                                )}
                            />
                        </div>
                    ) : (
                        <p className="vc-gif-vault-empty">
                            {favoriteGifs.length
                                ? "No favorites match these filters."
                                : "Your Discord GIF favorites will appear here."}
                        </p>
                    )}
                </section>
            </div>
        </Modal>
    );
}

const SafeGifVaultModal = ErrorBoundary.wrap(
    (props: { channelId: string; modalProps: RenderModalProps; }) => <GifVaultModal {...props} />,
    { noop: false },
);

export default definePlugin({
    name: "GifVault",
    description:
        "Organize favorite GIFs into folders, search them, and preview random favorites before posting.",
    authors: [author],
    settings,
    settingsAboutComponent: GifVaultBackupSettings,
    commands: [
        {
            name: "uploadgifshere",
            description: "Set this channel as the GIF Vault folder restore upload channel.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [],
            execute(_args, ctx) {
                void DataStore.set(RESTORE_CHANNEL_KEY, ctx.channel.id);
                sendBotMessage(ctx.channel.id, {
                    content:
                        "GIF Vault will upload restored GIF files to this channel. Do not delete this channel or server while folder restore is running.",
                });
            },
        },
    ],

    start() {
        document.addEventListener("keydown", onKeydown);
    },

    stop() {
        document.removeEventListener("keydown", onKeydown);
    },

    patches: [
        {
            find: "renderHeaderContent(){",
            replacement: {
                match: /children:\[(\i),this\.renderHeaderContent\(\)\]/,
                replace:
                    'children:[$1,this.renderHeaderContent(),this.state&&this.state.resultType==="Favorites"?$self.GifVaultButton():null]',
            },
        },
    ],

    GifVaultButton: ErrorBoundary.wrap(
        () => (
            <Button
                className="vc-gif-vault-pickerButton"
                variant="secondary"
                size="small"
                onClick={openGifVault}
            >
                Organize favorites
            </Button>
        ),
        { noop: true },
    ),
});
