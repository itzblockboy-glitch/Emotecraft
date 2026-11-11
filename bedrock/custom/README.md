# Custom emotes

Drop Emotecraft `.json` emote files in this folder, then rebuild:

```bash
cd ..
npm run build
```

Optional companion files (same base name):

| File | Purpose |
|---|---|
| `mydance.json` | the emote (required) |
| `mydance.png` | 256×256 icon shown in the wheel/library |
| `mydance.ogg` | audio; must be **Ogg Vorbis** (Bedrock cannot decode Opus) |
| `mydance.opus` | audio as shipped by Emotecraft; converted to Vorbis if Python + soundfile are available |

Supported schemas:

- `{"emote": {"moves": [...]}}` (Emotecraft schema 1–3, community emotes)
- `{"animations": {"id": {"bones": {...}}}}` (PlayerAnimationLibrary / Blender export)

The file name becomes the emote id (lowercased, non-alphanumerics become `_`).
