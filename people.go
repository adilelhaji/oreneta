package main

import (
	"errors"
	"fmt"
	"os"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// People, from whichever address books have been brought in. The bridge only
// carries them through; the core owns the books and what is in them.

// peopleList returns the address book, filtered by `query` when there is one.
//
// An engine that has not started answers with nobody rather than an error: the
// Personas view asks for these while the app is opening, and a screen that
// failed to load is a worse answer than one that is briefly empty.
func (a *App) peopleList(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return map[string]any{"people": []any{}}, nil
	}
	query, _ := payload["query"].(string)
	params := map[string]any{"query": query}
	if limit, ok := payload["limit"]; ok {
		params["limit"] = limit
	}
	return a.sidecar.Call("people.list", params)
}

// peopleWrite carries a write to the local address book (ADR-0012) through
// to the core unchanged: the version check and the conflict answer are the
// core's, and an engine that is not running cannot pretend to have saved.
func (a *App) peopleWrite(method string, payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	return a.sidecar.Call(method, payload)
}

// peopleRead carries a read of contact groups or of the book's names for
// some addresses (ADR-0052). Like peopleList, an engine that has not started
// answers with none rather than an error.
func (a *App) peopleRead(method string, payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		if method == "people.names" {
			return map[string]any{"names": map[string]any{}}, nil
		}
		return map[string]any{"groups": []any{}}, nil
	}
	return a.sidecar.Call(method, payload)
}

// peopleExportVcf writes the people asked for (all when none are named) to a
// .vcf the reader chooses (ADR-0012).
func (a *App) peopleExportVcf(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	params := map[string]any{}
	if ids, ok := payload["ids"].([]any); ok {
		params["ids"] = ids
	}
	res, err := a.sidecar.Call("people.exportVcf", params)
	if err != nil {
		return nil, err
	}
	answer, _ := res.(map[string]any)
	vcf, _ := answer["vcf"].(string)
	count := jsonInt(answer["count"])
	if count == 0 {
		return nil, errors.New("there is nobody to export")
	}
	dest, err := wailsRuntime.SaveFileDialog(a.ctx, wailsRuntime.SaveDialogOptions{
		Title:                "Export contacts",
		DefaultFilename:      "contacts.vcf",
		CanCreateDirectories: true,
		Filters:              []wailsRuntime.FileFilter{{DisplayName: "vCard (*.vcf)", Pattern: "*.vcf"}},
	})
	if err != nil {
		return nil, err
	}
	if dest == "" {
		return map[string]any{"saved": false}, nil
	}
	// Contacts are personal data: owner-only, like a backup.
	if err := writePrivateFile(dest, []byte(vcf)); err != nil {
		return nil, fmt.Errorf("write contacts: %w", err)
	}
	return map[string]any{"saved": true, "count": count, "path": dest}, nil
}

// peopleImportVcf brings people in from a .vcf in two steps: the first call
// picks the file and answers with a preview and its path; the second, with
// that path and a book, stores them. Nothing is stored by the first.
func (a *App) peopleImportVcf(payload map[string]any) (any, error) {
	if a.sidecar == nil || !a.sidecar.Started() {
		return nil, a.engineUnavailable()
	}
	src, _ := payload["path"].(string)
	confirm, _ := payload["confirm"].(bool)
	if src == "" {
		chosen, err := wailsRuntime.OpenFileDialog(a.ctx, wailsRuntime.OpenDialogOptions{
			Title:   "Import contacts",
			Filters: []wailsRuntime.FileFilter{{DisplayName: "vCard (*.vcf, *.vcard)", Pattern: "*.vcf;*.vcard"}},
		})
		if err != nil {
			return nil, err
		}
		if chosen == "" {
			return map[string]any{"cancelled": true}, nil
		}
		src = chosen
	}
	info, err := os.Stat(src)
	if err != nil {
		return nil, fmt.Errorf("read contacts: %w", err)
	}
	if info.Size() > maxVcfBytes {
		return nil, errors.New("the file is larger than 20 MB, which is not an address book")
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return nil, fmt.Errorf("read contacts: %w", err)
	}
	if !confirm {
		res, err := a.sidecar.Call("people.importPreview", map[string]any{"vcf": string(data)})
		if err != nil {
			return nil, err
		}
		answer, _ := res.(map[string]any)
		answer["path"] = src
		return answer, nil
	}
	book, _ := payload["book"].(string)
	return a.sidecar.Call("people.import", map[string]any{"vcf": string(data), "book": book})
}

// maxVcfBytes matches the core's limit; checked here too so a huge file is
// never read into memory at all.
const maxVcfBytes = 20 * 1024 * 1024
