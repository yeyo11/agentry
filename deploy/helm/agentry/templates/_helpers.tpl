{{- define "agentry.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "agentry.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "agentry.labels" -}}
app.kubernetes.io/name: {{ include "agentry.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "agentry.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentry.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The claim the pod mounts: the one the chart makes, or the one the operator brought */}}
{{- define "agentry.claim" -}}
{{- default (include "agentry.fullname" .) .Values.persistence.existingClaim -}}
{{- end -}}

{{/* Name of the Secret holding the API token, or empty when the mode needs none */}}
{{- define "agentry.tokenSecret" -}}
{{- if eq .Values.auth.mode "token" -}}
{{- default (printf "%s-auth" (include "agentry.fullname" .)) .Values.auth.token.existingSecret -}}
{{- end -}}
{{- end -}}
