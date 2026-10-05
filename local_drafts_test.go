package main

import (
	"io"
	"strings"
	"testing"
	"time"
)

func TestLocalDraftCommandsPreservePayloadAndResult(t *testing.T) {
	for _, command := range []string{"localDrafts.save", "localDrafts.delete", "localDrafts.get", "localDrafts.list"} {
		t.Run(command, func(t *testing.T) {
			app, writer := newMailHandlerTestApp(t, sidecarResponsePlan{Result: map[string]any{"applied": false, "revision": float64(2)}})
			payload := map[string]any{"id": "draft-1", "expected_revision": float64(1), "document": map[string]any{"version": float64(1), "attachment": "AAH/"}}
			result, err := app.invoke(command, payload)
			if err != nil {
				t.Fatal(err)
			}
			if len(writer.calls) != 1 {
				t.Fatalf("unexpected calls: %d", len(writer.calls))
			}
			assertCall(t, writer.calls[0], command, payload)
			if result.(map[string]any)["applied"] != false {
				t.Fatal("conflict must remain explicit")
			}
		})
	}
}

type failingDraftReader struct{}

func (failingDraftReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

type blockedDraftWriter struct {
	entered chan struct{}
	stopped chan struct{}
}

func (w *blockedDraftWriter) Write([]byte) (int, error) {
	close(w.entered)
	<-w.stopped
	return 0, io.ErrClosedPipe
}
func (w *blockedDraftWriter) Close() error { return nil }

func TestLocalDraftTransportFailureReleasesBlockedWrite(t *testing.T) {
	writer := &blockedDraftWriter{entered: make(chan struct{}), stopped: make(chan struct{})}
	sidecar := &Sidecar{started: true, stdin: writer, pending: map[uint64]chan sidecarResponse{}}
	callDone := make(chan error, 1)
	go func() { _, err := sidecar.Call("localDrafts.save", map[string]any{}); callDone <- err }()
	<-writer.entered
	readDone := make(chan struct{})
	go func() { sidecar.readLoop(nil, failingDraftReader{}, func() { close(writer.stopped) }); close(readDone) }()
	select {
	case <-readDone:
	case <-time.After(2 * time.Second):
		t.Fatal("failed reader deadlocked behind request write")
	}
	select {
	case err := <-callDone:
		if err == nil {
			t.Fatal("failed write acknowledged")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("write did not stop")
	}
	if sidecar.Started() {
		t.Fatal("failed transport still started")
	}
	if len(sidecar.pending) != 0 {
		t.Fatal("pending write retained after failure")
	}
}

func TestLocalDraftCommandsNeverAcknowledgeWithoutEngine(t *testing.T) {
	for _, command := range []string{"localDrafts.save", "localDrafts.delete", "localDrafts.get", "localDrafts.list"} {
		app := &App{}
		if _, err := app.invoke(command, nil); err == nil {
			t.Fatalf("%s falsely acknowledged unavailable engine", command)
		}
	}
}

func TestLocalDraftResponseTransportAcceptsLargeDocuments(t *testing.T) {
	ch := make(chan sidecarResponse, 1)
	sidecar := &Sidecar{pending: map[uint64]chan sidecarResponse{1: ch}}
	data := strings.Repeat("a", 20*1024*1024)
	sidecar.readLoop(nil, strings.NewReader(`{"id":1,"result":{"document":"`+data+`"}}`+"\n"), nil)
	select {
	case res := <-ch:
		if res.Error != nil || res.Result.(map[string]any)["document"] != data {
			t.Fatal("large document was truncated or rejected")
		}
	default:
		t.Fatal("large response was not delivered")
	}
}

func TestLocalDraftResponseTransportRejectsOversizeWithoutHanging(t *testing.T) {
	ch := make(chan sidecarResponse, 1)
	app, writer := newMailHandlerTestApp(t)
	sidecar := app.sidecar
	sidecar.pending[1] = ch
	cancelled := false
	sidecar.cancel = func() { cancelled = true }
	sidecar.readLoop(nil, strings.NewReader(strings.Repeat("x", maxSidecarResponseBytes)), sidecar.cancel)
	select {
	case res := <-ch:
		if res.Error == nil {
			t.Fatal("oversized response must fail explicitly")
		}
	default:
		t.Fatal("pending request was left waiting")
	}
	if len(sidecar.pending) != 0 {
		t.Fatal("failed requests were retained")
	}
	if sidecar.Started() || !cancelled {
		t.Fatal("failed transport remains active")
	}
	if _, err := sidecar.Call("localDrafts.save", map[string]any{}); err == nil {
		t.Fatal("failed transport accepted a new write")
	}
	if err := sidecar.Start(nil); err == nil {
		t.Fatal("failed transport restarted without a fresh lifecycle")
	}
	if len(writer.calls) != 0 {
		t.Fatal("wrote after transport failure")
	}
}
