package com.paypal.contractdemo.orders;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class ContractAuthFilter extends OncePerRequestFilter {
  private final byte[] expected;

  ContractAuthFilter(@Value("${contract.demo.token}") String token) {
    if (token == null || token.isBlank()) {
      throw new IllegalStateException("contract.demo.token must be supplied by the lower-environment secret");
    }
    expected = ("Bearer " + token).getBytes(StandardCharsets.UTF_8);
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    return !request.getRequestURI().startsWith("/v2/checkout/orders");
  }

  @Override
  protected void doFilterInternal(
    HttpServletRequest request,
    HttpServletResponse response,
    FilterChain filterChain
  ) throws ServletException, IOException {
    byte[] actual = String.valueOf(request.getHeader("Authorization")).getBytes(StandardCharsets.UTF_8);
    if (!MessageDigest.isEqual(expected, actual)) {
      response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
      response.setContentType(MediaType.APPLICATION_JSON_VALUE);
      response.getWriter().write(
        "{\"name\":\"AUTHENTICATION_FAILURE\",\"message\":\"Bearer token is missing or invalid.\",\"debug_id\":\"contract-demo\"}"
      );
      return;
    }
    filterChain.doFilter(request, response);
  }
}
