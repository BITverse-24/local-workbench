def read(path):
    with open(path) as handle:
        return [line.strip().split(",", 1) for line in handle if line.strip()]
