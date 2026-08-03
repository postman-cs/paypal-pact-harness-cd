package com.paypal.contractdemo.orders;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * CI-only Pact provider-state adapter for the stateless Orders contract wrapper.
 * Real services should dispatch named states to deterministic test-data setup and
 * teardown functions. This demo has no database, so every valid state is a no-op.
 */
@RestController
@RequestMapping("/_pact/provider-states")
public class ProviderStateController {

  @PostMapping
  @ResponseStatus(HttpStatus.OK)
  public Map<String, Object> apply(@RequestBody Map<String, Object> request) {
    String state = String.valueOf(request.getOrDefault("state", "")).trim();
    if (state.isEmpty()) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "provider state is required");
    }
    String action = String.valueOf(request.getOrDefault("action", "setup")).trim();
    if (!action.equals("setup") && !action.equals("teardown")) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "provider state action must be setup or teardown");
    }
    return Map.of("state", state, "action", action, "applied", true);
  }
}
