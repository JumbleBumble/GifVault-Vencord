# GIF Vault

Organize your Discord GIF favorites, find the right GIF, and preview random favorites before posting.

Open Discord's GIF picker and switch to **Favorites**. The **Organize favorites** button opens GIF Vault for the current chat.

## Features

- Create, rename, and delete folders, then assign a GIF to one or more folders.
- Use **All**, **Unfiled**, and folder tabs to filter favorites. Folder counts update with your organization.
- Search GIFs by title or source.
- Pick a random favorite, preview it, reroll if desired, and send it to the current chat.
- Export and import a JSON backup containing favorite GIFs and GIF Vault organization.

## Settings

Open GIF Vault's plugin settings to **Export GIF Vault** or **Import GIF Vault**.

Import adds GIFs from the backup only when they're missing from Discord favorites. It restores the backup's folders, assignments, and tile size, replacing the current GIF Vault organization.

## Installation

This is a Vencord userplugin and needs a Vencord build from source. Put this folder in `src/userplugins/gifVault`, build Vencord, enable GIF Vault in the Plugins settings, and restart Discord. See Vencord's [custom plugin instructions](https://docs.vencord.dev/installing/custom-plugins/) for details.