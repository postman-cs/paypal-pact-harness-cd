package com.paypal.contractdemo.orders;

import io.swagger.v3.oas.annotations.security.SecurityScheme;
import io.swagger.v3.oas.annotations.enums.SecuritySchemeType;
import io.swagger.v3.oas.annotations.security.OAuthFlow;
import io.swagger.v3.oas.annotations.security.OAuthFlows;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
@SecurityScheme(
  name = "Oauth2",
  type = SecuritySchemeType.OAUTH2,
  flows = @OAuthFlows(
    clientCredentials = @OAuthFlow(tokenUrl = "https://api-m.sandbox.paypal.com/v1/oauth2/token")
  )
)
public class OrdersApplication {
  public static void main(String[] args) {
    SpringApplication.run(OrdersApplication.class, args);
  }
}
