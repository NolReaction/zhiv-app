FROM gradle:9.5.0-jdk25 AS build

WORKDIR /home/gradle/project
COPY --chown=gradle:gradle . .
RUN gradle --no-daemon clean test installDist

FROM eclipse-temurin:25-jre

RUN useradd --system --uid 10001 --create-home zhiv
WORKDIR /app
COPY --from=build /home/gradle/project/build/install/zhiv-api/ ./
USER zhiv
EXPOSE 8080
ENTRYPOINT ["/app/bin/zhiv-api"]
