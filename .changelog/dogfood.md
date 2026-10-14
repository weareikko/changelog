### Changed

- The action runs `bin/changelog.js` when its directory has a build (`dist/cli.js`), so a built checkout of this repository uses its own CLI; a pinned action still runs the npm package
