/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { confirmAction, sendMessage } from "@utils/discord";
import { RenderModalProps } from "@vencord/discord-types";
import {
    FluxDispatcher,
    ListScrollerThin,
    MessageActions,
    Modal,
    openMediaModal,
    PendingReplyStore,
    ScrollerThin,
    SearchableSelect,
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
import type { PointerEvent as ReactPointerEvent } from "react";

import {
    getFavorites,
    getGifUrl,
    isGifSortOrder,
    isRecord,
    readLibraryData,
} from "../data/gifData";
import {
    DATA_KEY,
    EMPTY_LIBRARY,
    type FavoriteGif,
    type GifLibraryData,
    type GifSortOrder,
    type GifTileSize,
    TILE_SIZES,
    UNFILED,
} from "../data/types";
import { logger } from "../logger";
import { GifPreview, GifVaultCard } from "./GifVaultCard";

function TileSizeIcon({ size }: { size: GifTileSize }) {
    const tileCounts = {
        small: [3, 2],
        medium: [2, 2],
        large: [1, 1],
    } as const;
    const [columns, rows] = tileCounts[size];
    const gap = columns === 3 ? 2 : 3;
    const tileSize = (18 - gap * (columns - 1)) / columns;
    const tileHeight = (18 - gap * (rows - 1)) / rows;

    return (
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
            {Array.from({ length: columns * rows }, (_, index) => (
                <rect
                    key={index}
                    x={3 + (index % columns) * (tileSize + gap)}
                    y={3 + Math.floor(index / columns) * (tileHeight + gap)}
                    width={tileSize}
                    height={tileHeight}
                    rx="1"
                />
            ))}
        </svg>
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
    const [draggedFolder, setDraggedFolder] = useState<string>();
    const [dragOverFolder, setDragOverFolder] = useState<string>();
    const [editingGifKey, setEditingGifKey] = useState<string>();
    const [gifTitleDraft, setGifTitleDraft] = useState("");
    const [randomGif, setRandomGif] = useState<FavoriteGif>();
    const [saving, setSaving] = useState(false);
    const [columns, setColumns] = useState(5);
    const [gridHeight, setGridHeight] = useState(0);
    const gridRef = useRef<HTMLDivElement>(null);
    const vaultRef = useRef<HTMLDivElement>(null);
    const folderDragCleanupRef = useRef<(() => void) | null>(null);
    const suppressFolderClickRef = useRef(false);

    useEffect(() => {
        return () => folderDragCleanupRef.current?.();
    }, []);

    useEffect(() => {
        if (!maximized) return;

        const modalContent = vaultRef.current?.parentElement;
        if (!modalContent) return;

        const maxWidth = window.innerWidth * 0.95;
        const maxHeight = window.innerHeight * 0.95;
        const originalStyles = new Map<
            HTMLElement,
            Map<string, { value: string; priority: string }>
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

    function confirmDeleteFolder(name: string) {
        void confirmAction({
            title: `Delete ${name} folder?`,
            subtitle: "GIFs assigned to this folder will become unfiled.",
            confirmText: "Delete folder",
            onConfirm: () => deleteFolder(name),
        }).catch(error => {
            logger.error("Failed to confirm GIF Vault folder deletion", error);
            showToast({
                text: "Failed to delete the folder. Check the Vencord console for details.",
                variant: "critical",
            });
        });
    }

    function reorderFolders(source: string, target: string) {
        const sourceIndex = library.folders.indexOf(source);
        const targetIndex = library.folders.indexOf(target);
        if (saving || sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;

        const folders = [...library.folders];
        folders.splice(sourceIndex, 1);
        folders.splice(targetIndex, 0, source);
        void saveLibrary({ ...library, folders });
    }

    function clearFolderDrag() {
        setDraggedFolder(undefined);
        setDragOverFolder(undefined);
    }

    function beginFolderDrag(event: ReactPointerEvent<HTMLDivElement>, folder: string) {
        if (
            !library.folders.includes(folder) ||
            saving ||
            editingFolder === folder ||
            event.button !== 0 ||
            !event.isPrimary
        )
            return;

        folderDragCleanupRef.current?.();
        const { pointerId, clientX: startX, clientY: startY } = event;
        let isDragging = false;

        function getFolderAtPoint(clientX: number, clientY: number) {
            const element = document.elementFromPoint(clientX, clientY);
            if (!(element instanceof Element)) return;
            const tab = element.closest<HTMLElement>("[data-vc-gif-vault-folder]");
            const name = tab?.dataset.vcGifVaultFolder;
            if (!tab || !name || !library.folders.includes(name)) return;
            return name;
        }

        function cleanup() {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerCancel);
            if (folderDragCleanupRef.current === cleanup) folderDragCleanupRef.current = null;
        }

        function finish(pointerEvent: PointerEvent, commit: boolean) {
            if (pointerEvent.pointerId !== pointerId) return;
            if (isDragging) {
                if (commit) {
                    const target = getFolderAtPoint(pointerEvent.clientX, pointerEvent.clientY);
                    if (target) reorderFolders(folder, target);
                }
                suppressFolderClickRef.current = true;
                window.setTimeout(() => {
                    suppressFolderClickRef.current = false;
                }, 0);
            }
            clearFolderDrag();
            cleanup();
        }

        function onPointerMove(pointerEvent: PointerEvent) {
            if (pointerEvent.pointerId !== pointerId) return;
            if (!isDragging) {
                if (Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 6)
                    return;
                isDragging = true;
                setDraggedFolder(folder);
            }
            pointerEvent.preventDefault();
            setDragOverFolder(getFolderAtPoint(pointerEvent.clientX, pointerEvent.clientY));
        }

        function onPointerUp(pointerEvent: PointerEvent) {
            finish(pointerEvent, true);
        }

        function onPointerCancel(pointerEvent: PointerEvent) {
            finish(pointerEvent, false);
        }

        folderDragCleanupRef.current = cleanup;
        window.addEventListener("pointermove", onPointerMove, { passive: false });
        window.addEventListener("pointerup", onPointerUp);
        window.addEventListener("pointercancel", onPointerCancel);
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
                        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
                            {maximized ? (
                                <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3m13-5h-3a2 2 0 0 0-2 2v3" />
                            ) : (
                                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3" />
                            )}
                        </svg>
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
                                        <TileSizeIcon size={size} />
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
                                    className={`vc-gif-vault-folderTab${library.folders.includes(folder.value) ? " vc-gif-vault-folderTabReorderable" : ""}${folderFilter === folder.value ? " vc-gif-vault-folderTabSelected" : ""}${draggedFolder === folder.value ? " vc-gif-vault-folderTabDragging" : ""}${dragOverFolder === folder.value ? " vc-gif-vault-folderTabDropTarget" : ""}`}
                                    data-vc-gif-vault-folder={
                                        library.folders.includes(folder.value)
                                            ? folder.value
                                            : undefined
                                    }
                                    onPointerDown={event => beginFolderDrag(event, folder.value)}
                                    onClickCapture={event => {
                                        if (!suppressFolderClickRef.current) return;
                                        event.preventDefault();
                                        event.stopPropagation();
                                        suppressFolderClickRef.current = false;
                                    }}
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
                                            onClick={() => confirmDeleteFolder(folder.value)}
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

export const SafeGifVaultModal = ErrorBoundary.wrap(
    (props: { channelId: string; modalProps: RenderModalProps }) => <GifVaultModal {...props} />,
    { noop: false },
);
