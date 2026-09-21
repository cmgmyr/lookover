---
name: lookover
description: Use when a change landed and a human should try it, at session start to sweep feedback, or when a needs-work card came back.
---

# Lookover

Lookover is the manual-testing queue for one agent crew and one human tester.
It is not a tracker. Keep the human's side to exact steps, one verdict, and a paragraph.

## When a change lands

File a card with the CLI. Include a short title, exact steps, the expected result, the URL to open, and the work ref.

```sh
lookover add --title "Try the new header" --details-file steps.md --url "http://127.0.0.1:3000" --ref "todo-123"
```

The details must tell the tester what to do in order. Include the expected result and any setup or cleanup. Use `--details` for a short card, or `--details-file` for multiline steps. Attach the after-screenshot with `--image shot.png` (repeat for more, PNG, JPEG, WebP or GIF, 10 MB each, 5 per card).

Use `--source` to name the lane, PR, or other origin. Use `--project` when the current directory is not registered. Use `--retest-of <id>` only when this card retests a needs-work card.

## At session start

Sweep the cards waiting for the agent:

```sh
lookover feedback --json
```

Hive can carry the open count from `lookover open --count` in a board pad line, but Hive is not required.

Read each verdict and feedback. An `approved` card is accepted. A `note` card is information to record. A `needs-work` card requires a fix and a new retest card after the fix lands. A card's `files` array lists the tester's photos with absolute paths; open them before you act on the verdict.

## After processing feedback

Process every answered card with a note naming the work item, fix, or decision:

```sh
lookover process 123 --note "todo-123: fixed the mobile header spacing"
```

Do not reopen a processed card. File a new card for a retest, using `--retest-of` to connect it to the earlier card.

## Useful commands

```sh
lookover open --count
lookover list --json
lookover serve
```

`lookover serve` opens the local page. It listens on loopback by default. `--host 0.0.0.0` exposes an upload endpoint on the Wi-Fi and requires `--token <x>`.
