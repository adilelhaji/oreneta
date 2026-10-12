package main

import (
	"errors"
	"path/filepath"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// chatPickFile asks which file to send in a chat (ADR-0044). Only the path
// goes to the core, which streams it to the server's upload service.
func (a *App) chatPickFile() (any, error) {
	path, err := wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{Title: "Send a file"})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"cancelled": true}, nil
	}
	return describePickedFile(path)
}

// chatSaveFileAs saves a file someone sent as a link, where the person
// chooses. Nothing is fetched before this; the core fetches over HTTPS only.
func (a *App) chatSaveFileAs(payload map[string]any) (any, error) {
	url, _ := payload["url"].(string)
	if url == "" {
		return nil, errors.New("which file to save is missing")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	name, _ := payload["name"].(string)
	dest, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title:                "Save the file",
		DefaultFilename:      filepath.Base(name),
		CanCreateDirectories: true,
	})
	if err != nil {
		return nil, err
	}
	if dest == "" {
		return map[string]any{"saved": false}, nil
	}
	return a.sidecar.Call("chat.download", map[string]any{"url": url, "path": dest})
}
