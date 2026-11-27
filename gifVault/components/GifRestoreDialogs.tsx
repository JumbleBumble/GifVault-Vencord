/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";
import { RenderModalProps } from "@vencord/discord-types";
import { ChannelStore, ConfirmModal, Modal, openModal, TextInput, useState } from "@webpack/common";

export function askAboutExpiredGifUploads() {
    return new Promise<boolean>(resolve => {
        openModal(modalProps => (
            <ConfirmModal
                {...modalProps}
                title="Restore GIFs with expired links?"
                subtitle="GIF Vault found an organization manifest. It can upload locally saved GIFs with expired or unavailable links to Discord, then add them back with their original folders."
                confirmText="Yes, upload and restore"
                cancelText="No, use valid URLs only"
                onConfirm={() => resolve(true)}
                onCloseCallback={() => resolve(false)}
            />
        ));
    });
}

function GifRestoreChannelModal({
    modalProps,
    initialChannelId,
    onProceed,
    onCancel,
}: {
    modalProps: RenderModalProps;
    initialChannelId: string;
    onProceed: (channelId: string) => void;
    onCancel: () => void;
}) {
    const [channelId, setChannelId] = useState(initialChannelId);

    const validChannelId = /^\d{17,20}$/.test(channelId.trim());
    const channel = validChannelId ? ChannelStore.getChannel(channelId.trim()) : undefined;

    return (
        <Modal
            {...modalProps}
            title="Choose an upload channel"
            actions={[
                {
                    text: "Cancel",
                    variant: "secondary",
                    onClick: onCancel,
                },
                {
                    text: "Proceed with restore",
                    variant: "primary",
                    onClick: () => onProceed(channelId.trim()),
                    disabled: !channel,
                },
            ]}
        >
            <div className="vc-gif-vault-backupSettings">
                <Paragraph>
                    Enter the ID of a channel in an empty private server or a DM channel ID
                    (including a bot's DMs, which I'd recommend).
                </Paragraph>
                <Paragraph>
                    GIF Vault will send restore messages containing each uploaded GIF. Never delete
                    the server or channel, and avoid deleting or changing these uploaded messages.
                </Paragraph>
                <Paragraph>
                    You can use <code>/uploadgifshere</code> in a channel first instead of entering
                    an ID here. Run it before opening Restore GIFs from Folder again.
                </Paragraph>
                <Paragraph>
                    Uploading many GIFs may take time and may temporarily trigger Discord rate
                    limits. Try not to send other messages until the restore finishes.
                </Paragraph>
                <TextInput
                    value={channelId}
                    onChange={setChannelId}
                    placeholder="Discord channel ID"
                    aria-label="Discord upload channel ID"
                />
                {validChannelId && !channel && (
                    <Paragraph>
                        This channel was not found. Check the channel ID and make sure Discord can
                        access it.
                    </Paragraph>
                )}
            </div>
        </Modal>
    );
}

export function askForGifRestoreChannel(initialChannelId: string) {
    return new Promise<string | undefined>(resolve => {
        openModal(modalProps => (
            <GifRestoreChannelModal
                modalProps={modalProps}
                initialChannelId={initialChannelId}
                onProceed={channelId => {
                    modalProps.onClose();
                    resolve(channelId);
                }}
                onCancel={() => {
                    modalProps.onClose();
                    resolve(undefined);
                }}
            />
        ));
    });
}
