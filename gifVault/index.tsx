/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import {
    ListScrollerThin,
    Modal,
    openModal,
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
const UNFILED = "Unfiled";
const BACKUP_VERSION = 1;

const TILE_SIZES = {
    small: { label: "Small", minWidth: 142, rowHeight: 188 },
    medium: { label: "Medium", minWidth: 202, rowHeight: 222 },
    large: { label: "Large", minWidth: 282, rowHeight: 262 },
} as const;

type GifTileSize = keyof typeof TILE_SIZES;

interface FavoriteGif {
    key: string;
    title: string;
    url: string;
    previewUrl: string;
    gifSrc?: () => unknown;
}

interface GifLibraryData {
    folders: string[];
    assignments: Record<string, string[]>;
    layoutSize: GifTileSize;
}

const EMPTY_LIBRARY: GifLibraryData = { folders: [], assignments: {}, layoutSize: "small" };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
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

function getFavorites(): FavoriteGif[] {
    const favoriteGifs = UserSettingsProtoStore.frecencyWithoutFetchingLatest.favoriteGifs as
        | {
              gifs?: Record<string, unknown>;
          }
        | undefined;
    if (!favoriteGifs?.gifs) return [];

    return Object.entries(favoriteGifs.gifs).flatMap(([key, value]) => {
        if (!isRecord(value)) return [];

        const url =
            httpUrl(value.url) ?? httpUrl(value.src) ?? httpUrl(value.gifSrc) ?? httpUrl(key);
        const previewUrl =
            httpUrl(value.src) ?? httpUrl(value.url) ?? httpUrl(value.gifSrc) ?? httpUrl(key);
        if (!url || !previewUrl) return [];

        return [
            {
                key,
                title:
                    typeof value.title === "string" && value.title
                        ? value.title
                        : typeof value.name === "string" && value.name
                          ? value.name
                          : new URL(url).hostname,
                url,
                previewUrl,
                gifSrc:
                    typeof value.gifSrc === "function"
                        ? (value.gifSrc as () => unknown)
                        : undefined,
            },
        ];
    });
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
    return gif.url;
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
    const layoutSize =
        value.layoutSize === "medium" || value.layoutSize === "large" ? value.layoutSize : "small";
    return { folders: [...new Set(folders)], assignments, layoutSize };
}

function selectedFolderValues(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item =>
        typeof item === "string"
            ? [item]
            : isRecord(item) && typeof item.value === "string"
              ? [item.value]
              : [],
    );
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
        if (httpUrl(value.url) || httpUrl(value.src) || httpUrl(key)) favorites[key] = serializable;
    }
    return favorites;
}

function readBackupFavorites(value: unknown): Record<string, Record<string, unknown>> {
    if (!isRecord(value)) return {};

    const favorites = Object.create(null) as Record<string, Record<string, unknown>>;
    for (const [key, entry] of Object.entries(value)) {
        if (!isRecord(entry)) continue;

        const url = httpUrl(entry.url) ?? httpUrl(entry.src) ?? httpUrl(key);
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
        favorite.url = httpUrl(entry.url) ?? url;
        favorite.src = httpUrl(entry.src) ?? url;
        favorites[httpUrl(key) ? key : url] = favorite;
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

async function importGifVaultBackup(file: File) {
    const backup = JSON.parse(await file.text()) as unknown;
    if (!isRecord(backup) || backup.version !== BACKUP_VERSION || !isRecord(backup.library))
        throw new Error("This is not a supported GIF Vault backup.");

    const library = readLibraryData(backup.library);
    const importedFavorites = readBackupFavorites(backup.favoriteGifs);
    let addedFavorites = 0;
    if (Object.keys(importedFavorites).length) {
        await UserSettingsActionCreators.FrecencyUserSettingsActionCreators.updateAsync(
            "favoriteGifs",
            current => {
                if (!isRecord(current))
                    throw new Error("Discord's favorite GIF settings are unavailable.");
                const gifs = isRecord(current.gifs) ? current.gifs : {};
                current.gifs = gifs;
                for (const [key, favorite] of Object.entries(importedFavorites)) {
                    if (Object.hasOwn(gifs, key)) continue;
                    gifs[key] = favorite;
                    addedFavorites++;
                }
            },
            0,
        );
    }

    await DataStore.set(DATA_KEY, library);
    return addedFavorites;
}

const GifVaultBackupSettings = ErrorBoundary.wrap(
    () => {
        const inputRef = useRef<HTMLInputElement>(null);
        const [busy, setBusy] = useState(false);

        async function exportBackup() {
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

        async function importBackup(input: HTMLInputElement) {
            const file = input.files?.[0];
            input.value = "";
            if (!file) return;

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
                    this Discord account.
                </Paragraph>
                <div className="vc-gif-vault-backupActions">
                    <Button variant="secondary" onClick={exportBackup} disabled={busy}>
                        Export GIF Vault
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
                </div>
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

function GifVaultModal({
    channelId,
    modalProps,
}: {
    channelId: string;
    modalProps: RenderModalProps;
}) {
    const favoriteGifs = useStateFromStores([UserSettingsProtoStore], getFavorites);
    const [library, setLibrary] = useState<GifLibraryData>(EMPTY_LIBRARY);
    const [loaded, setLoaded] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [search, setSearch] = useState("");
    const [folderFilter, setFolderFilter] = useState("");
    const [newFolder, setNewFolder] = useState("");
    const [editingFolder, setEditingFolder] = useState<string>();
    const [folderNameDraft, setFolderNameDraft] = useState("");
    const [randomGif, setRandomGif] = useState<FavoriteGif>();
    const [saving, setSaving] = useState(false);
    const [columns, setColumns] = useState(5);
    const gridRef = useRef<HTMLDivElement>(null);

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
        if (!randomGif && favoriteGifs.length > 0)
            setRandomGif(favoriteGifs[Math.floor(Math.random() * favoriteGifs.length)]);
    }, [favoriteGifs, randomGif]);

    const filteredGifs = useMemo(() => {
        const query = search.trim().toLocaleLowerCase();
        return favoriteGifs.filter(gif => {
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
    }, [favoriteGifs, folderFilter, library.assignments, search]);
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
            const nextColumns = Math.max(
                1,
                Math.min(5, Math.floor((node.clientWidth + 12) / (tileSize.minWidth + 12))),
            );
            setColumns(current => (current === nextColumns ? current : nextColumns));
        });
        observer.observe(node);

        return () => observer.disconnect();
    }, [loaded, filteredGifs.length > 0, library.layoutSize]);

    async function saveLibrary(next: GifLibraryData) {
        setSaving(true);
        try {
            await DataStore.set(DATA_KEY, next);
            setLibrary(next);
        } catch (error) {
            logger.error("Failed to save GIF folder data", error);
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
            sendMessage(channelId, { content: await getGifUrl(randomGif) });
            modalProps.onClose();
        } catch (error) {
            logger.error("Failed to send a favorite GIF", error);
            setLoadError(true);
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
    return (
        <Modal
            {...modalProps}
            title="GIF Vault"
            subtitle="Organize your Discord favorites, find the right GIF, and preview it before posting."
            size="xl"
            actions={[{ text: "Done", variant: "secondary", onClick: modalProps.onClose }]}
        >
            <div className={`vc-gif-vault vc-gif-vault-${library.layoutSize}`}>
                {loadError && (
                    <div className="vc-gif-vault-notice" role="alert">
                        Some GIF Vault data could not be loaded or saved. Check the Vencord console
                        for details.
                    </div>
                )}

                <section className="vc-gif-vault-random">
                    <div className="vc-gif-vault-randomPreview">
                        {randomGif ? (
                            <GifPreview key={randomGif.key} gif={randomGif} resolveGifSrc />
                        ) : (
                            <div className="vc-gif-vault-previewPlaceholder" aria-hidden="true">
                                GIF
                            </div>
                        )}
                        <div className="vc-gif-vault-randomInfo">
                            <h3>Random pick</h3>
                            <p>Roll a favorite, preview it, then send it to the current chat.</p>
                            {randomGif ? (
                                <>
                                    <strong>{randomGif.title}</strong>
                                    <span className="vc-gif-vault-folderLabel">
                                        {library.assignments[randomGif.key]?.join(", ") || UNFILED}
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
                                    {randomGif ? "Reroll" : "Pick a favorite"}
                                </Button>
                                <Button
                                    variant="primary"
                                    onClick={sendRandomGif}
                                    disabled={!randomGif}
                                >
                                    Send to chat
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
                        <span className="vc-gif-vault-count">
                            {filteredGifs.length} GIF{filteredGifs.length === 1 ? "" : "s"}
                        </span>
                    </div>
                    <div className="vc-gif-vault-folderTabs" aria-label="Filter GIFs by folder">
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
                                    <span className="vc-gif-vault-folderCount">{folder.count}</span>
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

                    {!loaded ? (
                        <p className="vc-gif-vault-empty">Loading your GIF folders…</p>
                    ) : filteredGifs.length ? (
                        <div className="vc-gif-vault-gridScroller" ref={gridRef}>
                            <ListScrollerThin
                                className="vc-gif-vault-gridScrollerInner"
                                sections={[gifRows.length]}
                                sectionHeight={0}
                                rowHeight={tileSize.rowHeight}
                                chunkSize={chunkSize}
                                renderSection={() => null}
                                renderRow={({ row }) => (
                                    <div
                                        key={`gif-row-${row}`}
                                        className="vc-gif-vault-gridRow"
                                        style={{
                                            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                                        }}
                                    >
                                        {gifRows[row].map(gif => (
                                            <article className="vc-gif-vault-card" key={gif.key}>
                                                <button
                                                    type="button"
                                                    className={`vc-gif-vault-cardPreview${randomGif?.key === gif.key ? " vc-gif-vault-cardSelected" : ""}`}
                                                    onClick={() => setRandomGif(gif)}
                                                    aria-label={`Preview ${gif.title} above`}
                                                    aria-pressed={randomGif?.key === gif.key}
                                                >
                                                    <GifPreview gif={gif} compact />
                                                </button>
                                                <div
                                                    className="vc-gif-vault-cardTitle"
                                                    title={gif.title}
                                                >
                                                    {gif.title}
                                                </div>
                                                <SearchableSelect
                                                    placeholder={
                                                        library.assignments[gif.key]?.length
                                                            ? "Folders"
                                                            : UNFILED
                                                    }
                                                    options={[
                                                        { label: UNFILED, value: "" },
                                                        ...library.folders.map(folder => ({
                                                            label: folder,
                                                            value: folder,
                                                        })),
                                                    ]}
                                                    value={library.assignments[gif.key] ?? []}
                                                    onChange={value => {
                                                        const folders = selectedFolderValues(value);
                                                        assignFolders(
                                                            gif.key,
                                                            folders.includes("") ? [] : folders,
                                                        );
                                                    }}
                                                    multi
                                                    closeOnSelect={false}
                                                    isDisabled={saving}
                                                    maxVisibleItems={6}
                                                />
                                            </article>
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
    (props: { channelId: string; modalProps: RenderModalProps }) => <GifVaultModal {...props} />,
    { noop: false },
);

export default definePlugin({
    name: "GifVault",
    description:
        "Organize favorite GIFs into folders, search them, and preview random favorites before posting.",
    authors: [author],
    settingsAboutComponent: GifVaultBackupSettings,

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
