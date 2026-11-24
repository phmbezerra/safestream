// Package policy evaluates authorization checks for an already connected
// media participant. Both denial and unavailability fail closed, but they are
// explicitly distinguished in the audit log and WebSocket close code.
package policy

import (
	"context"
	"errors"
	"time"

	"github.com/phmbezerra/safestream/sfu/internal/auth"
)

type Decision struct {
	Event     string
	ReasonKey string
	CloseCode int
	CloseText string
}

// Classify returns whether media authorization must be terminated.
// A role change fails closed just like membership revocation.
func Classify(expectedRole, returnedRole string, err error) (Decision, bool) {
	if err == nil && returnedRole == expectedRole {
		return Decision{}, false
	}
	if errors.Is(err, auth.ErrUnauthorized) {
		return Decision{Event: "authorization_rejected", ReasonKey: "membership_denied", CloseCode: 4003, CloseText: "room membership revoked"}, true
	}
	if err != nil {
		return Decision{Event: "authorization_unavailable", ReasonKey: "authorization_api_unavailable", CloseCode: 1013, CloseText: "authorization service unavailable"}, true
	}
	return Decision{Event: "authorization_rejected", ReasonKey: "role_mismatch", CloseCode: 4003, CloseText: "room role changed"}, true
}

// Watch revalidates active media access. There is NO fail-open grace period:
// the first failed check triggers the caller-owned endpoint shutdown.
// This is laboratory behavior, not a latency guarantee or availability SLA.
func Watch(ctx context.Context, interval, timeout time.Duration, expectedRole string,
	check func(context.Context) (string, error), onBlock func(Decision)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			probe, cancel := context.WithTimeout(ctx, timeout)
			returnedRole, err := check(probe)
			cancel()
			if ctx.Err() != nil { // Shutdown was requested while the check was in flight.
				return
			}
			if decision, block := Classify(expectedRole, returnedRole, err); block {
				onBlock(decision)
				return
			}
		}
	}
}
