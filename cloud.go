package main

import (
	"os"
	"path/filepath"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// cloudPickFile asks which file to share by link (#108). Only the path goes to
// the core, which streams it from disk; the file is never read into the page.
func (a *App) cloudPickFile() (any, error) {
	path, err := wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{Title: "Share a file by link"})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"cancelled": true}, nil
	}
	return describePickedFile(path)
}

func describePickedFile(path string) (any, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "name": filepath.Base(path), "size": info.Size()}, nil
}
