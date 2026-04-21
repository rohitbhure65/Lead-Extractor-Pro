# Task: Set "No Limit" and "Phone Only" defaults to ON

## Plan Summary
- Edit popup/popup.js: Change defaults in loadExtractionSettings()
  - noLimit: Boolean(saved?.noLimit) || true
  - requirePhone: Boolean(saved?.requirePhone) || true
- [x] Step 1: Edit popup/popup.js with the changes
- [x] Step 2: Test extension (reload, open popup, verify checkboxes checked)
- [x] Step 3: Clear storage if needed and verify defaults work
- [ ] Step 4: Complete task

