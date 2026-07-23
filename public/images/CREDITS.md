# Image credits

All photos from Unsplash (unsplash.com), used under the Unsplash License
(free for commercial use, no attribution required — credited here anyway).
Downloaded via the Unsplash CDN (`images.unsplash.com/photo-<id>`), resized
and re-compressed locally (ImageMagick, JPEG q80) to keep the repo small.
No hotlinking — every file below is committed to this folder.

## Services (public/images/services/)

| File | Unsplash photo | Source URL |
|---|---|---|
| massage.jpg | photo-1544161515-4ab6ce6db874 | https://unsplash.com/photos/4ab6ce6db874 (images.unsplash.com/photo-1544161515-4ab6ce6db874) |
| hair.jpg | photo-1522337360788-8b13dee7a37e | images.unsplash.com/photo-1522337360788-8b13dee7a37e |
| nails.jpg | photo-1604654894610-df63bc536371 | images.unsplash.com/photo-1604654894610-df63bc536371 |
| face.jpg | photo-1512290923902-8a9f81dc236c | images.unsplash.com/photo-1512290923902-8a9f81dc236c |

Mapping used in UI: `body_zone` from `/api/services` → image file
(`body`→massage.jpg, `hair`→hair.jpg, `hands`→nails.jpg, `face`→face.jpg).
See `src/app/lib/serviceImages.ts`.

## Staff avatars (public/images/staff/)

| File | Unsplash photo |
|---|---|
| lan.jpg | images.unsplash.com/photo-1544005313-94ddf0286df2 |
| huong.jpg | images.unsplash.com/photo-1580489944761-15a19d654956 |
| mai.jpg | images.unsplash.com/photo-1531123897727-8f129e1688ce |
| trang.jpg | images.unsplash.com/photo-1607746882042-944635dfe10e |
| yen.jpg | images.unsplash.com/photo-1573496359142-b8d87734a5a2 |

Mapping used in UI: seed staff name → avatar file (see
`src/app/lib/staffAvatars.ts`). These are stock portraits standing in for
the 5 seeded staff names (Lan, Huong, Mai, Trang, Yen) — not real photos of
real people, purely illustrative headshots to make the UI feel less empty.

## Processing

```
magick <raw>.jpg -resize "WxH^" -gravity center -extent WxH -quality 80 -strip <out>.jpg
```
Services: 800x600. Staff: 400x400 (square crop, face-centered via Unsplash
`crop=faces` param at download time).
