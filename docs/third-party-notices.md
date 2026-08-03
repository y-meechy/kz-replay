# Third-party notices

This repository combines project-authored code with data, formats, tools, and
optional generated assets from other projects and rights holders. The project's
AGPL-3.0-only `LICENSE` applies to the covered source code. It does not grant rights in
third-party material merely because that material can be downloaded, converted,
displayed, or appears in a screenshot.

This notice is a practical inventory, not legal advice or a complete determination
of the rights that apply to a particular deployment. Before redistributing a
pre-populated image, converted asset, screenshot, or public service, review the
relevant upstream terms and obtain any permissions you need.

## CS2KZ

The tick decoder is a JavaScript port of the replay implementation in
[cs2kz-metamod](https://github.com/KZGlobalTeam/cs2kz-metamod), whose source is
licensed under AGPL-3.0. The relevant implementation is linked
at the immutable revision
[`7bf63fd18f588bd69e91c9236eb44392be57ec11`](https://github.com/KZGlobalTeam/cs2kz-metamod/tree/7bf63fd18f588bd69e91c9236eb44392be57ec11/src/kz/replays).
The original C++ source file is not vendored in this repository. This repository
uses AGPL-3.0-only consistently with that port's upstream license.

Record and map metadata are obtained from the public
[CS2KZ API](https://api.cs2kz.org/), and replay files are obtained from the CS2KZ
replay service. Availability through those services does not itself grant a right
to republish the data or files in another product.

## Map conversion tools

Map conversion is powered by
[Source 2 Viewer / ValveResourceFormat](https://github.com/ValveResourceFormat/ValveResourceFormat).
Optional asset retrieval also uses
[SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD) and
[DepotDownloader](https://github.com/SteamRE/DepotDownloader). These programs and
their dependencies retain their own copyright notices and license terms. They are
downloaded as tools; their licenses are not replaced by this project's AGPL license.

The npm packages listed in `package.json` likewise retain their own licenses. See
their package metadata and distributed license files before redistribution.

## Steam Workshop maps and mapper content

Steam Workshop maps, geometry, textures, materials, models, lightmaps, artwork,
and related content belong to their respective authors or other rights holders.
The converter does not relicense them. A generated `.glb`, texture, lightmap, or
sky file may contain or derive from that third-party content.

The viewer presents mapper credits supplied by the CS2KZ API. Retain those credits
with redistributed conversions and include the map's Workshop link where available.
Check the Workshop item's terms and contact its creator when your intended
redistribution is not clearly permitted. Generated maps are ignored by Git and
excluded from the Docker build context to reduce the chance of publishing a local
conversion accidentally.

## Valve and Counter-Strike assets

The optional sky and CT player-model pipelines extract assets from Counter-Strike 2. Those assets are Valve content and are not licensed under this repository's
AGPL license. Do not commit them to this repository. Review Valve's applicable
terms before hosting or redistributing them.

Counter-Strike, Counter-Strike 2, Steam, Valve, and their associated logos and
marks belong to Valve Corporation or their respective owners. This project is an
unofficial community project and is not affiliated with, endorsed by, or sponsored
by Valve Corporation, CS2KZ, Steam Workshop map authors, or the tool projects named
above.

## Documentation images

The repository contributors created the screenshots under `docs/` for this
documentation and license their original contributions under AGPL-3.0-only. The
screenshots also depict Counter-Strike 2 assets and third-party Workshop maps. That
license does not grant rights in the underlying map or game content; those rights
remain with their respective owners. The README identifies the pictured map where
known and links to its Workshop page.
