/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { showToast, UserSettingsActionCreators } from "@webpack/common";

import {
    getFavoriteIdentityUrl,
    getFavorites,
    getGifUrlCandidates,
    getNativeFavoriteMap,
    getSerializableFavoriteMap,
    isRecord,
    readBackupFavorites,
    readLibraryData,
} from "../data/gifData";
import {
    BACKUP_VERSION,
    DATA_KEY,
    type FavoriteGif,
    type GifFolderExportProgress,
    type GifLibraryData,
    isGifFolderManifest,
} from "../data/types";
import { logger } from "../logger";
import { Native } from "../nativeApi";
import { readDirectoryManifest } from "./folderFiles";

export async function exportGifVaultBackup() {
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

let gifExportProgress: GifFolderExportProgress | undefined;
let gifExportBusy = false;
const gifExportSubscribers = new Set<
    (progress: GifFolderExportProgress | undefined, busy: boolean) => void
>();

export function updateGifExportStatus(
    progress: GifFolderExportProgress | undefined,
    busy = gifExportBusy,
) {
    gifExportProgress = progress;
    gifExportBusy = busy;
    for (const subscriber of gifExportSubscribers) subscriber(gifExportProgress, gifExportBusy);
}

export function subscribeGifExportStatus(
    subscriber: (progress: GifFolderExportProgress | undefined, busy: boolean) => void,
) {
    gifExportSubscribers.add(subscriber);
    subscriber(gifExportProgress, gifExportBusy);
    return () => {
        gifExportSubscribers.delete(subscriber);
    };
}

export function getGifExportProgress() {
    return gifExportProgress;
}

export async function exportFavoriteGifsToNativeFolder(
    folderPath: string,
    signal: AbortSignal,
    onProgress: (progress: GifFolderExportProgress) => void,
) {
    if (!Native) throw new Error("Native folder export is unavailable.");

    const library = readLibraryData(await DataStore.get<unknown>(DATA_KEY));
    const gifs = getFavorites();
    if (!gifs.length) throw new Error("No favorite GIFs are currently available to download.");

    const existingByKey = new Map<string, { filename: string }>();
    const existingByUrl = new Map<string, { filename: string }>();
    const manifestJson = await Native.readTextFile(folderPath, "gif-vault-export.json");
    if (manifestJson) {
        try {
            const existingManifest = JSON.parse(manifestJson) as unknown;
            if (isGifFolderManifest(existingManifest) && Array.isArray(existingManifest.files)) {
                for (const file of existingManifest.files) {
                    if (
                        !isRecord(file) ||
                        typeof file.filename !== "string" ||
                        typeof file.key !== "string"
                    )
                        continue;
                    existingByKey.set(file.key, { filename: file.filename });
                    const favorite = existingManifest.favoriteGifs?.[file.key];
                    if (isRecord(favorite)) {
                        const identityUrl = getFavoriteIdentityUrl(file.key, favorite);
                        if (identityUrl)
                            existingByUrl.set(identityUrl, { filename: file.filename });
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
    const failed: Array<{ title: string; error: string }> = [];
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
    await Native.writeTextFile(
        folderPath,
        "gif-vault-export.json",
        JSON.stringify(manifest, null, 2),
    );
    return failed.length;
}

export async function exportFavoriteGifsToFolder(
    directory: FileSystemDirectoryHandle,
    signal: AbortSignal,
    onProgress: (progress: GifFolderExportProgress) => void,
) {
    const library = readLibraryData(await DataStore.get<unknown>(DATA_KEY));
    const gifs = getFavorites();
    if (!gifs.length) throw new Error("No favorite GIFs are currently available to download.");
    const existingFilesByKey = new Map<
        string,
        {
            index: number;
            filename: string;
            key: string;
            title: string;
            folders: string[];
        }
    >();
    const existingFilesByUrl = new Map<
        string,
        {
            index: number;
            filename: string;
            key: string;
            title: string;
            folders: string[];
        }
    >();
    try {
        const existingManifest = await readDirectoryManifest(directory);
        if (isGifFolderManifest(existingManifest) && Array.isArray(existingManifest.files)) {
            for (const file of existingManifest.files) {
                if (
                    !isRecord(file) ||
                    typeof file.filename !== "string" ||
                    typeof file.key !== "string"
                )
                    continue;

                const existingFile = {
                    index: typeof file.index === "number" ? file.index : 0,
                    filename: file.filename,
                    key: file.key,
                    title: typeof file.title === "string" ? file.title : "gif",
                    folders: Array.isArray(file.folders)
                        ? file.folders.filter(
                              (folder): folder is string => typeof folder === "string",
                          )
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
    const failed: Array<{ title: string; error: string }> = [];
    onProgress({ completed: 0, total: gifs.length, phase: "downloading" });

    for (const [index, gif] of gifs.entries()) {
        if (signal.aborted) throw new DOMException("The export was cancelled.", "AbortError");
        const title = getGifExportName(gif, library);
        const existingEntry = existingFilesByKey.get(gif.key) ?? existingFilesByUrl.get(gif.url);
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

export async function importGifVaultBackupData(backup: unknown) {
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

export async function importGifVaultBackup(file: File) {
    return importGifVaultBackupData(JSON.parse(await file.text()) as unknown);
}
