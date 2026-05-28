# Worker image: compiles cubiomes + seed_worker + seed_precompute.
# Build inside this image and ship the binaries via a volume mount or stage
# them into the bot image.
#
# Build target controlled by --build-arg WORKER_BUILD=<release|native>.
# Default is `release` (portable). On a single-host VPS deployment you
# can pass `--build-arg WORKER_BUILD=native` to enable -march=native
# (still safe — see packages/worker/Makefile for the cflag rationale).

FROM ubuntu:24.04 AS build

ARG WORKER_BUILD=release

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /worker
COPY . .
RUN make clean && make "${WORKER_BUILD}"

# Runtime stage: minimal image carrying only the binaries.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /worker/seed_worker /worker/seed_precompute /worker/seed_enrich /usr/local/bin/
CMD ["/usr/local/bin/seed_worker"]
