/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { showToast, useEffect, useRef, useState } from "@webpack/common";

import { positiveDimensionOr32 } from "../data/gifData";
import {
    BACKUP_VERSION,
    EMPTY_LIBRARY,
    type FileSystemDirectoryHandleWithPermission,
    type GifFolderDirectory,
    type GifFolderExportProgress,
    type GifFolderRestoreProgress,
    isGifFolderManifest,
    RESTORE_CHANNEL_KEY,
    type WindowWithDirectoryPicker,
} from "../data/types";
import { logger } from "../logger";
import { Native } from "../nativeApi";
import {
    exportFavoriteGifsToFolder,
    exportFavoriteGifsToNativeFolder,
    exportGifVaultBackup,
    getGifExportProgress,
    importGifVaultBackup,
    importGifVaultBackupData,
    subscribeGifExportStatus,
    updateGifExportStatus,
} from "../services/backup";
import { readGifFolderManifest, restoreGifFolder, uploadGifFilesToChannel } from "../services/restore";
import { askAboutExpiredGifUploads, askForGifRestoreChannel } from "./GifRestoreDialogs";

let gifExportAbortController: AbortController | null = null;

export const GifVaultBackupSettings = ErrorBoundary.wrap(
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
                        const savedChannelId =
                            (await DataStore.get<string>(RESTORE_CHANNEL_KEY)) ?? "";
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
                    const savedChannelId = (await DataStore.get<string>(RESTORE_CHANNEL_KEY)) ?? "";
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
            const savedChannelId = (await DataStore.get<string>(RESTORE_CHANNEL_KEY)) ?? "";
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
                    completed =>
                        setRestoreProgress({
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
                if (gifExportAbortController === controller) gifExportAbortController = null;
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
                            ...(getGifExportProgress() ?? {
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
                    const permission = await permissionHandle.requestPermission({
                        mode: "readwrite",
                    });
                    if (permission !== "granted")
                        throw new DOMException(
                            "Folder write permission was not granted.",
                            "NotAllowedError",
                        );
                }
                const failedCount = await exportFavoriteGifsToFolder(
                    directory,
                    controller.signal,
                    progress => updateGifExportStatus(progress, true),
                );
                updateGifExportStatus(
                    {
                        ...(getGifExportProgress() ?? {
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
                    text: failedCount
                        ? `Favorite GIF folder export completed with ${failedCount} unavailable GIF${failedCount === 1 ? "" : "s"}.`
                        : "Favorite GIFs exported to the selected folder.",
                    variant: "success",
                });
            } catch (error) {
                if (error instanceof DOMException && error.name === "AbortError") {
                    if (controller.signal.aborted) {
                        const progress = getGifExportProgress();
                        updateGifExportStatus(
                            progress ? { ...progress, phase: "cancelled" } : undefined,
                            false,
                        );
                    } else {
                        updateGifExportStatus(undefined, false);
                    }
                } else {
                    logger.error("Failed to download favorite GIFs", error);
                    const message =
                        error instanceof Error ? error.message : "Unknown folder export error";
                    updateGifExportStatus(
                        {
                            completed: 0,
                            total: 0,
                            phase: "error",
                        },
                        false,
                    );
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
