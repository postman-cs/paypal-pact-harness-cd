FROM maven:3.9.11-eclipse-temurin-21@sha256:6fdc855a6ed81d288ca7ca37ac6ff5e9308b612485c0801d70b25a858c83d237 AS build
WORKDIR /workspace
COPY pom.xml .
RUN mvn -B -DskipTests dependency:go-offline
COPY src src
RUN mvn -B package

FROM eclipse-temurin:21-jre@sha256:273396ed5998598ed1091e8d72711c2d36980a0e65103859c55a4e977a41ffd3
RUN useradd --system --uid 10001 --create-home spring
USER 10001
WORKDIR /app
COPY --from=build /workspace/target/orders-spring-wrapper-0.1.0.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
