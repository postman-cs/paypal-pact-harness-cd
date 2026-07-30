FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml .
RUN mvn -B -DskipTests dependency:go-offline
COPY src src
RUN mvn -B package

FROM eclipse-temurin:21-jre
RUN useradd --system --uid 10001 --create-home spring
USER 10001
WORKDIR /app
COPY --from=build /workspace/target/orders-spring-wrapper-0.1.0.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
