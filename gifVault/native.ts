/*
 * Vencord, a modification for Discord's web app
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { dialog, IpcMainInvokeEvent } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";

export async function selectFolder(_event: IpcMainInvokeEvent) {
    const result = await dialog.showOpenDialog({
        title: "Select GIF Vault export folder",
        properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
}

export async function readTextFile(_event: IpcMainInvokeEvent, folderPath: string, filename: string) {
    try {
        return await fs.readFile(path.join(folderPath, filename), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export async function fileSize(_event: IpcMainInvokeEvent, folderPath: string, filename: string) {
    try {
        return (await fs.stat(path.join(folderPath, filename))).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
    }
}

export async function writeBase64File(_event: IpcMainInvokeEvent, folderPath: string, filename: string, base64: string) {
    await fs.mkdir(folderPath, { recursive: true });
    await fs.writeFile(path.join(folderPath, filename), Buffer.from(base64, "base64"));
}

export async function writeTextFile(_event: IpcMainInvokeEvent, folderPath: string, filename: string, content: string) {
    await fs.mkdir(folderPath, { recursive: true });
    await fs.writeFile(path.join(folderPath, filename), content, "utf8");
}

export async function readFileBase64(_event: IpcMainInvokeEvent, folderPath: string, filename: string) {
    const buffer = await fs.readFile(path.join(folderPath, filename));
    return buffer.toString("base64");
}

export async function listFiles(_event: IpcMainInvokeEvent, folderPath: string) {
    return (await fs.readdir(folderPath, { withFileTypes: true }))
        .filter(entry => entry.isFile())
        .map(entry => entry.name);
}
