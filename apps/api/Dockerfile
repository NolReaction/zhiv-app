FROM gradle:9.6.0-jdk25 AS build

WORKDIR /home/gradle/project
COPY --chown=gradle:gradle . .
RUN ./gradlew --no-daemon clean test installDist

FROM eclipse-temurin:25-jre

RUN apt-get update \
    && apt-get install --yes --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home zhiv
WORKDIR /app
COPY --from=build /home/gradle/project/build/install/zhiv-api/ ./
USER zhiv
EXPOSE 8080
ENTRYPOINT ["/app/bin/zhiv-api"]
