package com.paypal.contractdemo.orders;

import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/v2/checkout/orders")
@SecurityRequirement(name = "Oauth2")
public class OrdersController {

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public Order create(@RequestBody(required = false) Map<String, Object> request) {
    String intent = String.valueOf(request == null ? "CAPTURE" : request.getOrDefault("intent", "CAPTURE"));
    return order(UUID.randomUUID().toString(), intent, "CREATED");
  }

  @GetMapping("/{id}")
  public Order get(@PathVariable String id) {
    return order(id, "CAPTURE", "COMPLETED");
  }

  @PatchMapping("/{id}")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void patch(@PathVariable String id, @RequestBody(required = false) List<Map<String, Object>> patch) {
    // Contract wrapper: route and request surface only; no persistence.
  }

  @PostMapping("/{id}/confirm-payment-source")
  public Order confirmPaymentSource(@PathVariable String id) {
    return order(id, "CAPTURE", "APPROVED");
  }

  @PostMapping("/{id}/authorize")
  public Order authorize(@PathVariable String id) {
    return order(id, "AUTHORIZE", "COMPLETED");
  }

  @PostMapping("/{id}/capture")
  public Order capture(@PathVariable String id) {
    return order(id, "CAPTURE", "COMPLETED");
  }

  @PostMapping("/{id}/track")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, String> track(@PathVariable String id, @RequestBody(required = false) Map<String, Object> tracker) {
    return Map.of("order_id", id, "tracker_id", "TRACKER-1", "status", "ACTIVE");
  }

  @PatchMapping("/{id}/trackers/{trackerId}")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void patchTracker(
    @PathVariable String id,
    @PathVariable String trackerId,
    @RequestBody(required = false) List<Map<String, Object>> patch
  ) {
    // Contract wrapper: route and request surface only; no persistence.
  }

  @PostMapping("/order-update-callback")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void orderUpdateCallback(@RequestBody(required = false) Map<String, Object> event) {
    // Contract wrapper: callback route only.
  }

  private static Order order(String id, String intent, String status) {
    return new Order(
      id,
      intent,
      status,
      Instant.parse("2026-01-01T00:00:00Z").toString(),
      List.of(new PurchaseUnit("default", new Amount("USD", "100.00")))
    );
  }

  public record Order(
    String id,
    String intent,
    String status,
    String create_time,
    List<PurchaseUnit> purchase_units
  ) {}

  public record PurchaseUnit(String reference_id, Amount amount) {}

  public record Amount(String currency_code, String value) {}
}
