import Pkg

# Install each sample's embedded environment before starting the timed UI tests.
# Keep these dependencies out of the extension's shared Pluto environment.
for name in ("Basic.jl", "PlutoTeachingTools.jl")
    source = read(joinpath(@__DIR__, "..", "samples", name), String)
    mktempdir() do environment
        for (variable, filename) in (
            ("PLUTO_PROJECT_TOML_CONTENTS", "Project.toml"),
            ("PLUTO_MANIFEST_TOML_CONTENTS", "Manifest.toml"),
        )
            contents = match(Regex(variable * "\\s*=\\s*\"\"\"(.*?)\"\"\"", "s"), source)
            isnothing(contents) && error("Missing $variable in $name")
            write(joinpath(environment, filename), contents.captures[1])
        end
        Pkg.activate(environment)
        Pkg.instantiate()
        Pkg.precompile()
    end
end
