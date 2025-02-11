# Change Log

All notable changes to the "code-dimmer" extension will be documented in this file.

## [3.0.0] - 2024-01-21

### Added
- New expand/shrink commands to control dimming selection size
  - `dimmer.ExpandDimmer` command (Ctrl+Shift+] or Cmd+Shift+] on Mac)
  - `dimmer.SrinkDimmer` command (Ctrl+Shift+[ or Cmd+Shift+[ on Mac)
- Clear dimming command with Escape key
- Status bar indicator showing dimming state
- Support for both indent-based and bracket-based selection

### Changed
- Improved selection tracking and containment checks
- More precise range calculations for both indentation and bracket-based dimming
- Better handling of nested code blocks

### Fixed
- Fixed issues with selection boundaries
- Improved handling of empty lines and whitespace
