package com.paypal.contractdemo.orders;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
class OrdersControllerTest {
  @Autowired
  MockMvc mvc;

  @Test
  void selectedOrdersEndpointsExposeTheConsumerShape() throws Exception {
    mvc.perform(post("/v2/checkout/orders")
        .contentType(MediaType.APPLICATION_JSON)
        .content("{\"intent\":\"CAPTURE\"}"))
      .andExpect(status().isCreated())
      .andExpect(jsonPath("$.status").value("CREATED"));

    mvc.perform(get("/v2/checkout/orders/5O190127TN364715T"))
      .andExpect(status().isOk())
      .andExpect(jsonPath("$.id").value("5O190127TN364715T"))
      .andExpect(jsonPath("$.intent").value("CAPTURE"))
      .andExpect(jsonPath("$.status").value("COMPLETED"))
      .andExpect(jsonPath("$.purchase_units[0].amount.currency_code").value("USD"));

    mvc.perform(post("/v2/checkout/orders/5O190127TN364715T/capture"))
      .andExpect(status().isOk())
      .andExpect(jsonPath("$.status").value("COMPLETED"));

    mvc.perform(post("/v2/checkout/orders/5O190127TN364715T/authorize"))
      .andExpect(status().isOk())
      .andExpect(jsonPath("$.intent").value("AUTHORIZE"));

    mvc.perform(post("/v2/checkout/orders/5O190127TN364715T/track")
        .contentType(MediaType.APPLICATION_JSON)
        .content("{}"))
      .andExpect(status().isCreated())
      .andExpect(jsonPath("$.tracker_id").value("TRACKER-1"));
  }

  @Test
  void generatedOpenApiInventoryIsAvailableToTheRouteGate() throws Exception {
    mvc.perform(get("/v3/api-docs"))
      .andExpect(status().isOk())
      .andExpect(jsonPath("$.paths['/v2/checkout/orders'].post").exists())
      .andExpect(jsonPath("$.paths['/v2/checkout/orders/{id}'].get").exists())
      .andExpect(jsonPath("$.paths['/v2/checkout/orders/{id}'].patch").exists())
      .andExpect(jsonPath("$.paths['/v2/checkout/orders/{id}/confirm-payment-source'].post").exists())
      .andExpect(jsonPath("$.paths['/v2/checkout/orders/{id}/authorize'].post").exists())
      .andExpect(jsonPath("$.paths['/v2/checkout/orders/{id}/capture'].post").exists())
      .andExpect(jsonPath("$.paths['/v2/checkout/orders/{id}/track'].post").exists())
      .andExpect(jsonPath("$.paths['/v2/checkout/orders/{id}/trackers/{trackerId}'].patch").exists())
      .andExpect(jsonPath("$.paths['/v2/checkout/orders/order-update-callback'].post").exists());
  }
}
