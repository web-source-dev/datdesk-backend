# Dat Desk auto-updates

Place Windows installers here, then generate `latest.yml`:

```bash
# After electron-builder produces "Dat Desk Setup 1.0.1.exe"
mkdir -p updates/datdesk/win32-x64
cp "/path/to/Dat Desk Setup 1.0.1.exe" updates/datdesk/win32-x64/

node scripts/generate-update-hash.js "updates/datdesk/win32-x64/Dat Desk Setup 1.0.1.exe" 1.0.1
```

Layout:
```
updates/
  datdesk/
    win32-x64/
      latest.yml
      Dat Desk Setup X.Y.Z.exe
```

Admin → Updates toggles auto-update on/off for `datdesk`.
