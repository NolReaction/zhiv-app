FROM gradle:9.6.0-jdk25 AS build

WORKDIR /home/gradle/project
COPY --chown=gradle:gradle . .
RUN ./gradlew --no-daemon clean test installDist \
    && NETTY_JAR="$(find build/install/zhiv-api/lib -maxdepth 1 -type f -name 'ktor-server-netty-jvm-*.jar' -print -quit)" \
    && test -n "${NETTY_JAR}" \
    && jar tf "${NETTY_JAR}" | grep --quiet --line-regexp 'io/ktor/server/netty/EngineMain.class'

FROM eclipse-temurin:25-jre

RUN apt-get update \
    && apt-get install --yes --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home zhiv
WORKDIR /app
COPY --from=build /home/gradle/project/build/install/zhiv-api/ ./
USER zhiv
EXPOSE 8080
ENTRYPOINT ["java", "-cp", "/app/lib/*", "io.ktor.server.netty.EngineMain"]
