# Changelog

All notable changes to this project are documented in this file.

## 0.3.0 - 2026-09-23

- Changed the Found something else? form to stay open after a send, cleared with the cursor in Title, so you can file several cards in a row.
- Added a Done button to the right of Send that closes the form and keeps anything half typed.
- Changed a sent card to show up in Waiting for the agent right away, in the spot a reload would put it.
- Changed the form's text fields to pause while a send is in flight, so the next card you start typing is not wiped.

## 0.2.1 - 2026-09-23

- Fixed `lookover --version` crashing when installed from npm.
- Changed releases to publish to npm from GitHub Actions with provenance.

## 0.2.0 - 2026-09-23

- Changed project tiles to rank by open count, with the row always showing All plus three projects and the current project taking the last tile.
- Added open counts to the Go to project list and the browser tab title.
- Added a project count under the All projects heading.
- Changed the README to lead with screenshots and a terminal demo, and added npm and CI badges.

## 0.1.0 - 2026-09-21

- Added a global and project-local store for manual-testing cards.
- Added CLI commands for adding, listing, opening, giving feedback, and processing cards.
- Added project registration, archiving, and all-project inbox views.
- Added import support for a legacy testing queue, including dry runs and image references.
- Added the built-in page for reviewing cards, submitting verdicts, and switching projects.
- Added screenshot uploads from the CLI and page, with image validation and metadata handling.
- Added `serve` replacement behavior and loopback defaults for the local server.
- Added the `lookover` agent skill installer and package skill path command.
