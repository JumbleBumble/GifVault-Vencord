/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export async function readDirectoryManifest(directory: FileSystemDirectoryHandle) {
    try {
        const handle = await directory.getFileHandle("gif-vault-export.json");
        return JSON.parse(await (await handle.getFile()).text()) as unknown;
    } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError") return;
        throw error;
    }
}
