/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import { RestAPI } from "@webpack/common";

import {
    getFavoriteIdentityUrl,
    httpUrl,
    isRecord,
    positiveDimensionOr32,
    readLibraryData,
} from "../data/gifData";
import {
    BACKUP_VERSION,
    type GifFolderDirectory,
    type GifFolderManifestFile,
    type GifFolderRestoreProgress,
    type GifLibraryData,
    isGifFolderManifest,
} from "../data/types";
import { logger } from "../logger";
import { Native } from "../nativeApi";
import { importGifVaultBackupData } from "./backup";

const { uniqueId } = findByPropsLazy("uniqueId");

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
    const canonical = candidates.find(
        candidate => candidate.filename === "gif-vault-export.json",
    );
    if (canonical) {
        const content = await canonical.read();
        if (content === undefined)
            throw new Error("The GIF Vault folder manifest could not be read.");
        const manifest = JSON.parse(content) as unknown;
        if (!isGifFolderManifest(manifest))
            throw new Error("The selected GIF Vault folder manifest is not supported.");
        return { manifest, filename: canonical.filename };
    }

    const validCandidates: Array<{ manifest: unknown; filename: string }> = [];
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
        throw new Error(
            "Multiple GIF Vault folder manifests were found. Keep only one in the folder.",
        );
    return validCandidates[0];
}

export async function readGifFolderManifest(directory: GifFolderDirectory) {
    if (typeof directory === "string") {
        const native = Native;
        if (!native) throw new Error("Native GIF folder access is unavailable.");
        const filenames = await native.listFiles(directory);
        const candidates = filenames
            .filter(filename => /\.json$/i.test(filename))
            .map(filename => ({
                filename,
                read: () => native.readTextFile(directory, filename),
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

async function isGifUrlReachable(url: string, signal: AbortSignal) {
    try {
        const response = await fetch(url, {
            signal,
            headers: { Range: "bytes=0-1023" },
        });
        if (!response.ok) return false;
        const contentType = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
        if (contentType)
            return contentType.startsWith("image/") || contentType.startsWith("video/");
        return /\.(gif|avif|webp|jpe?g|png|mp4|webm)(?:$|[?#])/i.test(url);
    } catch {
        return false;
    }
}

export async function uploadGifFilesToChannel(
    channelId: string,
    uploads: Array<{ file: File; name: string }>,
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

        let uploadedBatch: Array<{ id: string; upload_url: string; upload_filename: string }>;
        for (let attempt = 0; attempt < 4; attempt++) {
            if (signal.aborted) throw new DOMException("The restore was cancelled.", "AbortError");
            try {
                const response = (await RestAPI.post({
                    url: `/channels/${channelId}/attachments`,
                    body: {
                        files: batch.map((upload, id) => ({
                            filename: upload.file.name,
                            file_size: upload.file.size,
                            id: String(id),
                            is_clip: false,
                        })),
                    },
                })) as {
                    body: {
                        attachments: Array<{
                            id: string;
                            upload_url: string;
                            upload_filename: string;
                        }>;
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
                if (signal.aborted)
                    throw new DOMException("The restore was cancelled.", "AbortError");
                const allocation = uploadedBatch[index];
                if (!allocation) throw new Error(`Discord did not allocate ${upload.file.name}.`);

                const putResponse = await fetch(allocation.upload_url, {
                    method: "PUT",
                    body: upload.file,
                    signal,
                });
                if (!putResponse.ok)
                    throw new Error(
                        `Failed to upload ${upload.file.name}: HTTP ${putResponse.status}`,
                    );

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
        const message = (await RestAPI.post({
            url: `/channels/${channelId}/messages`,
            body: {
                channel_id: channelId,
                content: "",
                nonce: uniqueId(),
                flags: 0,
                type: 0,
                attachments: attachmentPayload,
            },
        })) as {
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

export async function restoreGifFolder(
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

    const entries =
        manifest?.files?.filter(
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
                    order:
                        isRecord(favorite) && typeof favorite.order === "number"
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
    const uploaded =
        uploadExpired && channelId
            ? await uploadGifFilesToChannel(
                  channelId,
                  expiredUploads.map(upload => ({ file: upload.file, name: upload.name })),
                  signal,
                  completed =>
                      onProgress({
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
