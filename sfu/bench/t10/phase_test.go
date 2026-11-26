package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestT10CPhaseMarker(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phase.txt")
	writePhase("", "active") // Optional flag must preserve original behavior.
	writePhase(path, "active")
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "active\n" {
		t.Fatalf("active marker: %q %v", got, err)
	}
	writePhase(path, "complete")
	got, err = os.ReadFile(path)
	if err != nil || string(got) != "complete\n" {
		t.Fatalf("complete marker: %q %v", got, err)
	}
}
