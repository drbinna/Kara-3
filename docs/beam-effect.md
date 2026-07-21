# The "beam" effect — recipe

The materialization look used for Kara's poster loop (`public/kara-beam-loop.mp4`,
the `#poster` video in `public/index.html`). This doc exists so the effect can be
rebuilt for any future persona without reverse-engineering the assets.

## What the effect is (visual spec)

- Subject centered, chest-up portrait, facing camera, gentle smile, 1920×1080.
- Background: near-black, cold navy falloff — the only light source is the beam.
- A single **volumetric blue-white spotlight cone from directly above**, apex just
  off the top of frame, widening to envelop the subject. Cool color temp
  (~7000K+, blue-steel), strong rim/top light on hair and shoulders.
- **Fine dust motes / sparkle particles** drifting slowly inside the light cone —
  dense like illuminated dust in a projector beam, brighter where the beam is.
- At higher intensities the subject is slightly **veiled by haze**, reading as
  mid-materialization (sci-fi "beaming in") — face stays clearly recognizable.
- Motion in the video masters is subtle: particles drift, haze breathes, subject
  is nearly still. Big motion breaks the palindrome bake (visible reversal).

## Asset inventory (all in `public/`, committed 4215808)

| File | Role |
|---|---|
| `kara-beam-a.png` … `kara-beam-d.png` | 4K still candidates, intensity ladder: a = subtle beam, b = denser sparkle, c = heavy haze, d = most materialized/veiled |
| `kara-beam-static.mp4` | 10 s, 1080p24 — the chosen master animation (source of the loop) |
| `kara-beam-live.mp4` | 10 s, 1080p24 — alternate master with livelier subject motion |
| `kara-particles-live.mp4` | 10 s, 1080p24 — particles-forward variant |
| `kara-beam-loop.mp4` | 20 s, 1080p24 — **canonical loop**: palindrome bake of the static master |

## Rebuild pipeline for a new persona

1. **Still pass** — image-edit the persona's canonical portrait (do NOT generate a
   new face; edit the existing likeness so identity is preserved). Higgsfield
   `nano-banana-pro` is the house tool; `get_cost:true` preflight, and decline
   style presets (they restyle the face). Generation prompt:

   > Keep this exact person completely unchanged — same face, hair, expression,
   > clothing, and pose. Replace the background and lighting only: pitch-black
   > studio background with a single volumetric blue-white spotlight cone shining
   > down from directly above, apex just above frame, widening to fully envelop
   > them. Cool blue-steel color temperature. Fine glowing dust particles drift
   > inside the light cone, dense like dust in a projector beam. Strong rim light
   > on hair and shoulders, soft ethereal haze, cinematic sci-fi
   > "materializing in a beam of light" mood. Photorealistic, 4K.

   Generate an intensity ladder (subtle → veiled) like a–d and pick by eye.

2. **Motion pass** — animate the chosen still with an identity-preserving
   image-to-video model (Seedance via Higgsfield). ~10 s, 1080p, 24 fps. Prompt:

   > Animate with minimal, loop-friendly motion: dust particles drift slowly and
   > continuously through the beam of light, the volumetric haze breathes gently,
   > light shimmers subtly. The person stays almost perfectly still — at most a
   > slow blink and micro head movement. No camera movement. The face must remain
   > exactly this person, unchanged.

3. **Identity check** (hard rule for Kara; good hygiene for any persona) —
   extract frames and compare against the source portrait before presenting:
   `ffmpeg -i out.mp4 -vf fps=1 /tmp/check-%02d.png`

4. **Palindrome bake** — make it seamlessly loopable (forward + reversed concat;
   this is why the loop is exactly 2× the master's duration):

   ```bash
   ffmpeg -i persona-beam-static.mp4 \
     -filter_complex "split[a][b];[b]reverse[r];[a][r]concat" \
     -an persona-beam-loop.mp4
   ```

5. **Ship** — save as `public/<persona>-beam-loop.mp4`, commit, push, then pin
   the jsDelivr URL to the new commit SHA in the persona's page
   (`https://cdn.jsdelivr.net/gh/drbinna/Kara-3@<sha>/public/<file>`), then
   redeploy. jsDelivr refuses files >20 MB — keep loops under that (Kara's is
   5.7 MB at 1080p24 / 20 s).
