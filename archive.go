package main

// The local archive (ADR-0014): importing .eml and .mbox files. The bridge
// picks the files and hands their paths to the core, which reads them; mail
// never travels through here as text, so binary mbox files arrive intact.

import (
	"errors"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// archiveImport works in two steps, like restoring a backup: the first call
// picks the files and answers with what importing them would do; the second,
// with those paths and confirm, imports. Nothing is stored by the first.
func (a *App) archiveImport(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	folder, _ := payload["folder"].(string)
	var paths []string
	if raw, ok := payload["paths"].([]any); ok {
		for _, item := range raw {
			if path, ok := item.(string); ok && path != "" {
				paths = append(paths, path)
			}
		}
	}
	if len(paths) == 0 {
		chosen, err := wailsRuntime.OpenMultipleFilesDialog(a.ctx, wailsRuntime.OpenDialogOptions{
			Title: "Import mail",
			Filters: []wailsRuntime.FileFilter{
				{DisplayName: "Mail (*.eml, *.mbox)", Pattern: "*.eml;*.mbox;*.mbx"},
				{DisplayName: "All files", Pattern: "*"},
			},
		})
		if err != nil {
			return nil, err
		}
		if len(chosen) == 0 {
			return map[string]any{"cancelled": true}, nil
		}
		paths = chosen
	}
	confirm, _ := payload["confirm"].(bool)
	method := "archive.preview"
	if confirm {
		method = "archive.import"
	}
	res, err := a.sidecar.Call(method, map[string]any{"paths": paths, "folder": folder})
	if err != nil {
		return nil, err
	}
	answer, ok := res.(map[string]any)
	if !ok {
		return nil, errors.New("unexpected answer from the core")
	}
	answer["paths"] = paths
	if confirm {
		a.logf("archive.import: %d file(s) into %q", len(paths), answer["folder"])
	}
	return answer, nil
}

// thunderbirdPickFolder asks for a Thunderbird profile, or one of its mail
// folders, when the profile was not found on its own (ADR-0041).
func (a *App) thunderbirdPickFolder() (any, error) {
	dir, err := wailsRuntime.OpenDirectoryDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Thunderbird profile or mail folder",
	})
	if err != nil {
		return nil, err
	}
	if dir == "" {
		return map[string]any{"cancelled": true}, nil
	}
	return map[string]any{"path": dir}, nil
}
