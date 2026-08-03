package com.paypal.contractdemo.orders;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(properties = "contract.demo.token=test-token")
@AutoConfigureMockMvc
class OrdersControllerTest {
  private static final String AUTHORIZATION = "Authorization";
  private static final String TOKEN = "Bearer test-token";
  @Autowired
  MockMvc mvc;

  @Test
  void selectedOrdersEndpointsExposeTheConsumerShape() throws Exception {
    mvc.perform(post("/v2/checkout/orders")
        .header(AUTHORIZATION, TOKEN)
        .contentType(MediaType.APPLICATION_JSON)
        .content("{\"intent\":\"CAPTURE\"}"))
      .andExpect(status().isCreated())
      .andExpect(jsonPath("$.status").value("CREATED"));

    mvc.perform(get("/v2/checkout/orders/5O190127TN364715T").header(AUTHORIZATION, TOKEN))
      .andExpect(status().isOk())
      .andExpect(jsonPath("$.id").value("5O190127TN364715T"))
      .andExpect(jsonPath("$.intent").value("CAPTURE"))
      .andExpect(jsonPath("$.status").value("COMPLETED"))
      .andExpect(jsonPath("$.purchase_units[0].amount.currency_code").value("USD"));

    mvc.perform(post("/v2/checkout/orders/5O190127TN364715T/capture").header(AUTHORIZATION, TOKEN))
      .andExpect(status().isOk())
      .andExpect(jsonPath("$.status").value("COMPLETED"));

    mvc.perform(post("/v2/checkout/orders/5O190127TN364715T/authorize").header(AUTHORIZATION, TOKEN))
      .andExpect(status().isOk())
      .andExpect(jsonPath("$.intent").value("AUTHORIZE"));

    mvc.perform(post("/v2/checkout/orders/5O190127TN364715T/track")
        .header(AUTHORIZATION, TOKEN)
        .contentType(MediaType.APPLICATION_JSON)
        .content("{}"))
      .andExpect(status().isCreated())
      .andExpect(jsonPath("$.tracker_id").value("TRACKER-1"));

    mvc.perform(patch("/v2/checkout/orders/5O190127TN364715T")
        .header(AUTHORIZATION, TOKEN)
        .contentType(MediaType.APPLICATION_JSON)
        .content("[{\"op\":\"replace\",\"path\":\"/intent\",\"value\":\"CAPTURE\"}]"))
      .andExpect(status().isNoContent());

    mvc.perform(post("/v2/checkout/orders/5O190127TN364715T/confirm-payment-source")
        .header(AUTHORIZATION, TOKEN))
      .andExpect(status().isOk())
      .andExpect(jsonPath("$.status").value("APPROVED"));

    mvc.perform(patch("/v2/checkout/orders/5O190127TN364715T/trackers/TRACKER-1")
        .header(AUTHORIZATION, TOKEN)
        .contentType(MediaType.APPLICATION_JSON)
        .content("[{\"op\":\"replace\",\"path\":\"/status\",\"value\":\"DELIVERED\"}]"))
      .andExpect(status().isNoContent());

    mvc.perform(post("/v2/checkout/orders/order-update-callback")
        .header(AUTHORIZATION, TOKEN)
        .contentType(MediaType.APPLICATION_JSON)
        .content("{\"id\":\"WH-LOWER-CONTRACT\"}"))
      .andExpect(status().isNoContent());
  }

  @Test
  void ordersRoutesRejectMissingAndInvalidBearerTokens() throws Exception {
    mvc.perform(get("/v2/checkout/orders/5O190127TN364715T"))
      .andExpect(status().isUnauthorized())
      .andExpect(jsonPath("$.name").value("AUTHENTICATION_FAILURE"));
    mvc.perform(get("/v2/checkout/orders/5O190127TN364715T")
        .header(AUTHORIZATION, "Bearer wrong-token"))
      .andExpect(status().isUnauthorized());
  }

  @Test
  void pactProviderStatesAreAuthenticatedAndDeterministic() throws Exception {
    mvc.perform(post("/_pact/provider-states")
        .contentType(MediaType.APPLICATION_JSON)
        .content("{\"state\":\"an order exists\",\"action\":\"setup\"}"))
      .andExpect(status().isUnauthorized());

    mvc.perform(post("/_pact/provider-states")
        .header(AUTHORIZATION, TOKEN)
        .contentType(MediaType.APPLICATION_JSON)
        .content("{\"state\":\"an order exists\",\"action\":\"setup\"}"))
      .andExpect(status().isOk())
      .andExpect(jsonPath("$.state").value("an order exists"))
      .andExpect(jsonPath("$.action").value("setup"))
      .andExpect(jsonPath("$.applied").value(true));

    mvc.perform(post("/_pact/provider-states")
        .header(AUTHORIZATION, TOKEN)
        .contentType(MediaType.APPLICATION_JSON)
        .content("{}"))
      .andExpect(status().isBadRequest());
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
    mvc.perform(get("/v3/api-docs"))
      .andExpect(jsonPath("$.components.securitySchemes.Oauth2").exists())
      .andExpect(jsonPath("$.paths['/v2/checkout/orders/{id}'].get.security[0].Oauth2").exists());
  }
}
