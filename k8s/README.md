# Optional standalone Kubernetes deployment

Harness builds the lower wrapper from source, so the normal contract-gate stage
does not pull this image. This manifest is only for teams that want the demo
service to remain deployed in a lower cluster.

The `postman-cs` organization currently requires GHCR packages to remain
private. Create the pull secret named by the manifest with a GitHub token that
has `read:packages`, then apply the deployment:

```bash
kubectl create namespace paypal-contract-lower \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n paypal-contract-lower create secret docker-registry postman-cs-ghcr \
  --docker-server=ghcr.io \
  --docker-username="$GITHUB_USER" \
  --docker-password="$GITHUB_TOKEN"

kubectl apply -f k8s/orders-spring-lower.yaml
kubectl -n paypal-contract-lower rollout status deployment/orders-spring
```

Keep the token out of Git and rotate it through the cluster's normal secret
management. The image in the manifest is pinned by digest.
