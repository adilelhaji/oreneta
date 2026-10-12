package main

// Files attached to notes (ADR-0042): the bridge asks which file to attach
// and where to save one; the core reads and writes the bytes itself.

import (
	"errors"
	"path/filepath"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) notesPickAttachment() (any, error) {
	path, err := wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{Title: "Attach a file to the note"})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"cancelled": true}, nil
	}
	return describePickedFile(path)
}

func (a *App) notesSaveAttachmentAs(payload map[string]any) (any, error) {
	id, _ := payload["id"].(string)
	if id == "" {
		return nil, errors.New("which file to save is missing")
	}
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	name, _ := payload["filename"].(string)
	dest, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title:                "Save the attached file",
		DefaultFilename:      filepath.Base(name),
		CanCreateDirectories: true,
	})
	if err != nil {
		return nil, err
	}
	if dest == "" {
		return map[string]any{"saved": false}, nil
	}
	return a.sidecar.Call("notes.saveAttachment", map[string]any{"id": id, "path": dest})
}
