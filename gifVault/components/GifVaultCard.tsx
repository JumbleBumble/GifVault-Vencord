/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { SearchableSelect, TextInput, useEffect, useState } from "@webpack/common";

import { httpUrl, selectedFolderValue } from "../data/gifData";
import { type FavoriteGif, UNFILED } from "../data/types";
import { logger } from "../logger";

export function GifPreview({
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

export function GifVaultCard({
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
