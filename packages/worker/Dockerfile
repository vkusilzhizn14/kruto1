# Worker image: compiles cubiomes + seed_worker + seed_precompute.
# Build inside this image and ship the binaries via a volume mount or stage
# them into the bot image.

FROM ubuntu:24.04 AS build

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /worker
COPY . .
RUN make clean && make

# Runtime stage: minimal image carrying only the binaries.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /worker/seed_worker /worker/seed_precompute /usr/local/bin/
CMD ["/usr/local/bin/seed_worker"]
