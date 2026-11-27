# GIF Vault for Vencord

**GIF Vault** is a Vencord plugin for organizing Discord GIF favorites into folders, searching and sorting your collection, previewing GIFs fullscreen, downloading all your Discord GIF favorites to your PC, and backing up or sharing your collection with flexible import and export options.

Open Discord's GIF picker, switch to **Favorites**, and select **Organize favorites** to open GIF Vault for the current chat. Your folder organization is stored separately from Discord's favorites, while GIF Vault works directly with the GIFs you have favorited.

## Quick start

1. Install GIF Vault as a Vencord userplugin.
2. Open Discord's GIF picker and go to **Favorites**.
3. Select **Organize favorites** to create folders, assign GIFs, search, sort, preview, and send.
4. Use `Ctrl+Shift+G` at any time, or set a custom shortcut in plugin settings.

## Why use GIF Vault?

- Turn an unorganized Discord GIF favorite list into searchable, filterable folders.
- Find a GIF quickly by title or source, sort it, and preview it before sending.
- Keep GIF collections portable across Discord accounts with JSON backups and folder exports.
- Recover locally saved GIF collections when Discord CDN links expire or become unavailable.

## Features

### Organize and browse

- Create, rename, and delete folders, then assign a GIF to one or more folders.
- Reorder folders by dragging their tabs.
- Filter favorites with **All**, **Unfiled**, and folder tabs.
- Set and rename custom GIF titles.
- Search GIF favorites by custom title or source URL.
- Sort by title in either direction or by newest/oldest favorite.
- Choose compact or large GIF tiles for your preferred viewing size.
- Fully maximizable GifVault window to make selecting, organizing and sorting your GIFs easier.

### Preview and send

- Preview GIFs directly inside GIF Vault or open the selected GIF in fullscreen.
- Shuffle through random favorites, reroll for a different result, then preview before sending.
- Send GIFs to the current channel and send as a Discord reply when a reply is pending.
- Remove GIFs directly from your Discord favorites from within GIF Vault.
- Open GIF Vault instantly with a customizable `Ctrl+Shift+G` keyboard shortcut.

### Backup, export, and restore

- Export a JSON backup containing favorite GIF data and GIF Vault folder organization.
- Import backups into another account or merge a backup into an existing collection without duplicating GIFs.
- Download all available favorites to a selected folder for local GIF and media backups.
- **Download all GIFs** also creates a `gif-vault-export.json` manifest alongside the downloaded files, preserving custom titles, folders, assignments, filenames, and export details.
- Restore GIFs from an exported folder, including links that are still reachable.
- Re-upload saved media for expired or unavailable GIF links and restore it to Discord favorites with the original organization/folders.
- Use `/uploadgifshere` to remember a channel for folder restore uploads.
- Monitor export and restore progress, including download, manifest, link-checking, upload, and import stages.
- Cancel export or restore operations while they are running.

## Built for transferable GIF collections

GIF Vault supports two backup workflows:

1. **JSON backup** - Share or migrate favorites and organization between Discord accounts.
2. **Media folder export** - Keep the actual GIF files locally and preserve a reimport-ready manifest for later restoration.

## Settings

Open GIF Vault's plugin settings to manage backups and GIF folders:

- **Open menu keybind** changes the shortcut used to open GIF Vault; the default is `Ctrl+Shift+G`.
- **Export GIF Vault** downloads a JSON backup of favorites and GIF Vault organization.
- **Import GIF Vault** merges a JSON backup into the current account, adding only missing favorites and restoring the backup's folders and assignments.
- **Download all GIFs** saves every available favorite to a selected folder, with a `gif-vault-export.json` manifest for reimporting.
- **Restore GIFs from Folder** reads an exported folder, restores available links, and optionally uploads missing or expired media to Discord.

During folder restore, GIF Vault asks for a Discord channel that can receive upload messages. Run `/uploadgifshere` in that channel to save it for later restores. Keep the channel and server available while restoration is running.

## Installation

This is a Vencord userplugin and requires a Vencord build from source. Download the [release](https://github.com/JumbleBumble/GifVault-Vencord/releases), extract the ZIP file, place the `gifVault` folder in `src/userplugins`, build Vencord, enable GIF Vault in the Plugins settings, and restart Discord. See Vencord’s [custom plugin instructions](https://docs.vencord.dev/installing/custom-plugins/) for details.

If you're setting up a Vencord build with custom plugins, I recommend using [Vencord Custom Updater](https://github.com/JumbleBumble/Vencord-Custom-Updater) to keep your Vencord install current while preserving custom plugins like GIF Vault.
