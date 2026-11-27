/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { UserSettingsProtoStore } from "@webpack/common";

import { EMPTY_LIBRARY, type FavoriteGif, type GifLibraryData, type GifSortOrder } from "./types";

export function isGifSortOrder(value: string): value is GifSortOrder {
    return (
        value === "added-oldest" ||
        value === "added-newest" ||
        value === "title-asc" ||
        value === "title-desc"
    );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function uint32OrZero(value: unknown): number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
        ? value
        : 0;
}

export function positiveDimensionOr32(value: unknown): number {
    return uint32OrZero(value) || 32;
}

export function httpUrl(value: unknown): string | undefined {
    if (typeof value !== "string") return;
    try {
        const url = new URL(value);
        if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch {
        return;
    }
}

export function normalizeGifProxyUrl(value: unknown): string | undefined {
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

export function normalizeGifFavoriteKey(value: unknown): string | undefined {
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

export function getFavoriteIdentityUrl(
    key: string,
    value: Record<string, unknown>,
): string | undefined {
    return (
        normalizeGifFavoriteKey(key) ??
        normalizeGifFavoriteKey(value.url) ??
        normalizeGifFavoriteKey(value.src)
    );
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

export function getFavorites(): FavoriteGif[] {
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

export function getNativeFavoriteMap(): Record<string, unknown> {
    const favoriteGifs = UserSettingsProtoStore.frecencyWithoutFetchingLatest.favoriteGifs as
        | {
              gifs?: Record<string, unknown>;
          }
        | undefined;
    return favoriteGifs?.gifs ?? {};
}

export async function getGifUrl(gif: FavoriteGif): Promise<string> {
    if (gif.gifSrc) {
        const resolved = httpUrl(await gif.gifSrc());
        if (resolved) return resolved;
    }
    return gif.downloadUrl ?? gif.url;
}

export async function getGifUrlCandidates(gif: FavoriteGif): Promise<string[]> {
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

export function readLibraryData(value: unknown): GifLibraryData {
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

export function selectedFolderValue(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (isRecord(value) && typeof value.value === "string") return value.value;
}

export function getSerializableFavoriteMap() {
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

export function readBackupFavorites(value: unknown): Record<string, Record<string, unknown>> {
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
