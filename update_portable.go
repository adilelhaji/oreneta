package main

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// oldExeSuffix marks the displaced copy of a running exe. Windows lets a
// running image be renamed but not overwritten, so the portable channel renames
// itself out of the way and the leftover is swept up on the next launch.
const oldExeSuffix = ".old"

// renameFile is os.Rename, replaceable in tests to make one step fail.
var renameFile = os.Rename

// replaceExecutableFrom swaps exe for the copy of it inside the portable zip:
// extract beside it, check it is a Windows executable, move the running one
// aside, move the new one in. If the last move fails the previous executable
// is put back, so a failed update leaves the installation as it was. The
// relaunch is the caller's.
//
// It lives outside update_install_windows.go so every step can be tested on
// any platform; only applyUpdate and the relaunch are Windows-specific.
func replaceExecutableFrom(archive, exe string) error {
	parent := filepath.Dir(exe)
	if err := ensureWritableDir(parent); err != nil {
		return fmt.Errorf("update: %s is not writable — install the update manually: %w", parent, err)
	}

	staging := filepath.Join(parent, fmt.Sprintf(".oreneta-update-%d.exe", os.Getpid()))
	_ = os.Remove(staging)
	if err := extractExeFromZip(archive, filepath.Base(exe), staging); err != nil {
		_ = os.Remove(staging)
		return err
	}

	previous := exe + oldExeSuffix
	_ = os.Remove(previous)
	if err := renameFile(exe, previous); err != nil {
		_ = os.Remove(staging)
		return fmt.Errorf("update: could not move the old executable aside: %w", err)
	}
	if err := renameFile(staging, exe); err != nil {
		if restoreErr := renameFile(previous, exe); restoreErr != nil {
			return fmt.Errorf("update: could not move the new executable into place (%v), nor put the previous one back; it is at %s: %w", err, previous, restoreErr)
		}
		_ = os.Remove(staging)
		return fmt.Errorf("update: could not move the new executable into place: %w", err)
	}
	return nil
}

// extractExeFromZip writes the archive entry named name to dest, refusing an
// entry that is not a Windows executable or is larger than any update may be.
func extractExeFromZip(archive, name, dest string) error {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return fmt.Errorf("update: the downloaded archive cannot be opened: %w", err)
	}
	defer reader.Close()
	for _, entry := range reader.File {
		if entry.FileInfo().IsDir() || !strings.EqualFold(filepath.Base(entry.Name), name) {
			continue
		}
		if entry.UncompressedSize64 > uint64(maxUpdatePayloadBytes) {
			return fmt.Errorf("update: %s in the downloaded archive is too large", name)
		}
		return extractEntry(entry, dest)
	}
	return fmt.Errorf("update: %s not found in the downloaded archive", name)
}

func extractEntry(entry *zip.File, dest string) error {
	source, err := entry.Open()
	if err != nil {
		return err
	}
	defer source.Close()
	// The declared size is the archive's claim; bound what is actually read too.
	limited := io.LimitReader(source, maxUpdatePayloadBytes+1)
	header := make([]byte, 2)
	if _, err := io.ReadFull(limited, header); err != nil || !bytes.Equal(header, []byte("MZ")) {
		return errors.New("update: the downloaded archive does not contain a Windows executable")
	}
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	written, err := io.Copy(out, io.MultiReader(bytes.NewReader(header), limited))
	if err != nil {
		out.Close()
		return fmt.Errorf("update: the downloaded archive is damaged: %w", err)
	}
	if written > maxUpdatePayloadBytes {
		out.Close()
		return errors.New("update: the executable in the downloaded archive is too large")
	}
	return out.Close()
}
