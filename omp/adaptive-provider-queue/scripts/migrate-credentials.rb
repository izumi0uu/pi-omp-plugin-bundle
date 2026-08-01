require "yaml"

models_path, env_path = ARGV
abort "usage: migrate-credentials.rb MODELS_YML ENV_FILE" unless models_path && env_path

targets = {
  "aiinput" => "AIINPUT_API_KEY",
  "tokenking-grok" => "TOKENKING_GROK_API_KEY",
}

env_text = File.exist?(env_path) ? File.read(env_path) : ""
env_values = {}
env_text.each_line do |line|
  match = /\A([A-Z][A-Z0-9_]*)=(.*)\z/.match(line.chomp)
  next unless match
  raw = match[2].strip
  env_values[match[1]] = if raw.start_with?("\"") || raw.start_with?("'")
    YAML.safe_load(raw)
  else
    raw
  end
end

current_provider = nil
resolved = {}
models_lines = File.readlines(models_path)
models_lines.map! do |line|
  provider_match = /\A  ([A-Za-z0-9_-]+):\s*\z/.match(line)
  current_provider = provider_match[1] if provider_match
  variable = targets[current_provider]
  key_match = /\A    apiKey:\s*(.*?)\s*\z/.match(line)
  next line unless variable && key_match

  configured = YAML.safe_load(key_match[1]).to_s
  value = configured == variable ? env_values[variable] : (ENV[configured] || configured)
  abort "missing credential for #{current_provider}" unless value && value.length >= 20
  abort "unsupported credential characters for #{current_provider}" unless /\A[A-Za-z0-9_.-]+\z/.match?(value)
  resolved[variable] = value
  "    apiKey: #{variable}\n"
end

missing = targets.values - resolved.keys
abort "credentials not found for: #{missing.join(', ')}" unless missing.empty?

env_lines = env_text.lines
resolved.each do |variable, value|
  replacement = "#{variable}=#{value}\n"
  index = env_lines.index { |line| line.start_with?("#{variable}=") }
  if index
    env_lines[index] = replacement
  else
    env_lines << "\n" unless env_lines.empty? || env_lines.last.end_with?("\n\n")
    env_lines << replacement
  end
end

def atomic_write(path, content)
  temp = "#{path}.tmp-#{Process.pid}"
  File.open(temp, File::WRONLY | File::CREAT | File::TRUNC, 0o600) { |file| file.write(content) }
  File.chmod(0o600, temp)
  File.rename(temp, path)
end

atomic_write(env_path, env_lines.join)
atomic_write(models_path, models_lines.join)
puts "migrated credential references: #{targets.keys.join(', ')}"
