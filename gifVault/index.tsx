/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { openModal, SelectedChannelStore } from "@webpack/common";

import { GifVaultBackupSettings } from "./components/GifVaultBackupSettings";
import { SafeGifVaultModal } from "./components/GifVaultModal";
import { DEFAULT_OPEN_KEYBIND, RESTORE_CHANNEL_KEY } from "./data/types";

const author = { name: "Jumble", id: 1135976262234542233n };

const settings = definePluginSettings({
    openMenuKeybind: {
        type: OptionType.STRING,
        displayName: "Open menu keybind",
        description: "Keyboard shortcut to open GIF Vault, for example Ctrl+Shift+G.",
        default: DEFAULT_OPEN_KEYBIND,
        isValid: value => typeof value === "string" && !!getKeybindModifiers(value),
    },
});

function getKeybindModifiers(value: string) {
    const parts = value
        .split("+")
        .map(part => part.trim().toLocaleLowerCase())
        .filter(Boolean);
    if (!parts.length) return;

    const modifiers = {
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
    };
    let key: string | undefined;
    for (const part of parts) {
        switch (part) {
            case "ctrl":
            case "control":
                if (modifiers.ctrl) return;
                modifiers.ctrl = true;
                break;
            case "alt":
                if (modifiers.alt) return;
                modifiers.alt = true;
                break;
            case "shift":
                if (modifiers.shift) return;
                modifiers.shift = true;
                break;
            case "meta":
            case "cmd":
            case "command":
                if (modifiers.meta) return;
                modifiers.meta = true;
                break;
            default:
                if (key) return;
                key = part;
        }
    }

    if (!key || ["ctrl", "control", "alt", "shift", "meta", "cmd", "command"].includes(key)) return;
    return { ...modifiers, key };
}

function onKeydown(event: KeyboardEvent) {
    if (event.repeat || document.querySelector(".vc-gif-vault")) return;
    const { key: pressedKey, ctrlKey, altKey, shiftKey, metaKey, target } = event;
    const keybind = getKeybindModifiers(settings.store.openMenuKeybind);
    if (!keybind) return;
    const { key: configuredKey, ctrl, alt, shift, meta } = keybind;
    if (pressedKey.toLocaleLowerCase() !== configuredKey) return;
    if (ctrlKey !== ctrl || altKey !== alt || shiftKey !== shift || metaKey !== meta) return;

    if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select, [role='textbox']"))
    )
        return;

    event.preventDefault();
    openGifVault();
}

function openGifVault() {
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) return;

    openModal(modalProps => <SafeGifVaultModal channelId={channelId} modalProps={modalProps} />);
}

export default definePlugin({
    name: "GifVault",
    description:
        "Organize favorite GIFs into folders, search them, and preview random favorites before posting.",
    authors: [author],
    settings,
    settingsAboutComponent: GifVaultBackupSettings,
    commands: [
        {
            name: "uploadgifshere",
            description: "Set this channel as the GIF Vault folder restore upload channel.",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [],
            execute(_args, ctx) {
                void DataStore.set(RESTORE_CHANNEL_KEY, ctx.channel.id);
                sendBotMessage(ctx.channel.id, {
                    content:
                        "GIF Vault will upload restored GIF files to this channel. Do not delete this channel or server while folder restore is running.",
                });
            },
        },
    ],

    start() {
        document.addEventListener("keydown", onKeydown);
    },

    stop() {
        document.removeEventListener("keydown", onKeydown);
    },

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
