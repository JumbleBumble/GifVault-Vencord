# GIF Vault

Organize your Discord GIF favorites, find the right GIF, and preview random favorites before posting.

Open Discord's GIF picker and switch to **Favorites**. The **Organize favorites** button opens GIF Vault for the current chat.

## Features

- Create, rename, and delete folders, then assign a GIF to one or more folders.
- Use **All**, **Unfiled**, and folder tabs to filter favorites. Folder counts update with your organization.
- Search GIFs by title or source.
- Set custom titles for GIFs.
- Sort favorites alphabetically or Newest/Oldest added as favorites.
- Open the selected GIF preview in fullscreen.
- Remove GIFs directly from Discord favorites from within GIF Vault.
- Send a random GIF to the chat with the ability to preview it and reroll before sending.
- Export and import a JSON backup containing favorite GIFs and GIF Vault organization, also useful for sharing gif collections between accounts.

## Settings

Open GIF Vault's plugin settings to **Export GIF Vault** or **Import GIF Vault**.

Import adds GIFs from the backup only when they're missing from Discord favorites. It restores the backup's folders and assignments, adding to the current GIF Vault organization.

## Installation

This is a Vencord userplugin and requires a Vencord build from source. Download the [release](https://github.com/JumbleBumble/GifVault-Vencord/releases), extract the ZIP file, place the `gifVault` folder in `src/userplugins`, build Vencord, enable GIF Vault in the Plugins settings, and restart Discord. See Vencord’s [custom plugin instructions](https://docs.vencord.dev/installing/custom-plugins/) for details.

If you're setting up a Vencord build with custom plugins, I recommend using [Vencord Custom Updater](https://github.com/JumbleBumble/Vencord-Custom-Updater) to keep your Vencord install current while preserving custom plugins like GIF Vault.
