/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Jumble
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";

export const Native = !IS_WEB
    ? (VencordNative.pluginHelpers.GifVault as PluginNative<typeof import("./native")>)
    : undefined;
