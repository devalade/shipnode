# Release Guide

## Creating a New Release

### 1. Update Version

Update the version in these files:
- `shipnode` (line 13: `VERSION="x.x.x"`)
- `install.sh` (line 13: `ShipNode Installer vx.x.x`)
- `build-dist.sh` (line 8: `VERSION="x.x.x"`)

### 2. Build Distribution

```bash
make build
```

This creates `dist/shipnode-installer.sh`.

### 3. Test Installer

Test the installer locally:

```bash
bash dist/shipnode-installer.sh
```

Choose a test location and verify it works.

### 4. Commit and Tag

```bash
git add .
git commit -m "Release vx.x.x"
git tag -a vx.x.x -m "Version x.x.x"
git push origin main
git push origin vx.x.x
```

### 5. Automatic Release

The GitHub Action will automatically:
- Build the installer
- Create a GitHub release
- Upload `shipnode-installer.sh` as a release asset

### 6. Manual Release (Alternative)

If you prefer manual releases:

1. Go to GitHub releases: https://github.com/devalade/shipnode/releases
2. Click "Draft a new release"
3. Choose the tag you just pushed
4. Upload `dist/shipnode-installer.sh`
5. Write release notes
6. Publish release

## Release Checklist

- [ ] Version updated in all files
- [ ] Distribution built successfully
- [ ] Installer tested locally
- [ ] Changes committed
- [ ] Tag created and pushed
- [ ] GitHub release created
- [ ] Release notes written
- [ ] Installer URL works:
  ```
  curl -fsSL https://github.com/devalade/shipnode/releases/latest/download/shipnode-installer.sh
  ```

## Version Numbering

Follow semantic versioning:
- **Major** (x.0.0): Breaking changes
- **Minor** (1.x.0): New features, backwards compatible
- **Patch** (1.0.x): Bug fixes

## Release Notes Template

```markdown
## What's New

- Feature 1
- Feature 2
- Bug fix 1

## Installation

Download and run:
\`\`\`bash
curl -fsSL https://github.com/devalade/shipnode/releases/download/vx.x.x/shipnode-installer.sh | bash
\`\`\`

Or from source:
\`\`\`bash
git clone https://github.com/devalade/shipnode.git
cd shipnode
git checkout vx.x.x
./install.sh
\`\`\`

## Changelog

Full changelog: vx.x.x-1...vx.x.x
```

## Rollback

If a release has issues:

1. Delete the tag:
   ```bash
   git tag -d vx.x.x
   git push origin :refs/tags/vx.x.x
   ```

2. Delete the GitHub release

3. Fix issues and re-release
