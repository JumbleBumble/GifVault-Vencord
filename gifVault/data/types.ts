/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const DATA_KEY = "GifVault_library";
export const RESTORE_CHANNEL_KEY = "GifVault_restoreChannelId";
export const UNFILED = "Unfiled";
export const BACKUP_VERSION = 1;
export const DEFAULT_OPEN_KEYBIND = "Ctrl+Shift+G";

export const TILE_SIZES = {
    small: { label: "Small", minWidth: 202, rowHeight: 222 },
    medium: { label: "Medium", minWidth: 282, rowHeight: 262 },
    large: { label: "Large", minWidth: 380, rowHeight: 310 },
} as const;

export type GifTileSize = keyof typeof TILE_SIZES;
export type GifSortOrder = "added-oldest" | "added-newest" | "title-asc" | "title-desc";

export interface FavoriteGif {
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

export interface GifLibraryData {
    folders: string[];
    assignments: Record<string, string[]>;
    titleOverrides: Record<string, string>;
    layoutSize: GifTileSize;
}

export interface GifFolderManifestFile {
    index: number;
    filename: string;
    key: string;
    title: string;
    folders: string[];
}

export interface GifFolderManifest {
    format: "gif-vault-folder-export";
    version: number;
    favoriteGifs?: Record<string, Record<string, unknown>>;
    library?: unknown;
    files?: GifFolderManifestFile[];
}

export interface GifFolderRestoreProgress {
    completed: number;
    total: number;
    phase: "preparing" | "checking" | "uploading" | "importing" | "complete" | "cancelled";
}

export type GifFolderDirectory = FileSystemDirectoryHandle | string;

export function isGifFolderManifest(value: unknown): value is GifFolderManifest {
    return (
        typeof value === "object" &&
        value !== null &&
        "format" in value &&
        value.format === "gif-vault-folder-export"
    );
}

export const EMPTY_LIBRARY: GifLibraryData = {
    folders: [],
    assignments: {},
    titleOverrides: {},
    layoutSize: "small",
};

export interface GifFolderExportProgress {
    completed: number;
    total: number;
    phase: "preparing" | "downloading" | "manifest" | "complete" | "cancelled" | "error";
    failed?: number;
}

export type WindowWithDirectoryPicker = Window & {
    showDirectoryPicker?: (options?: {
        mode?: "read" | "readwrite";
    }) => Promise<FileSystemDirectoryHandle>;
};

export type FileSystemDirectoryHandleWithPermission = FileSystemDirectoryHandle & {
    requestPermission?: (options?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
};
