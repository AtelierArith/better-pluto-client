### A Pluto.jl notebook ###
# v0.20.19

using Markdown
using InteractiveUtils

# ╔═╡ 2d9e9e13-f659-4fd3-b318-6bd3016fbc38
begin
    using Plots
    import ImageShow
    using TestImages
    using PlutoUI
end

# ╔═╡ 1a453479-8e69-4c0e-8d2f-4578d5b74353
@bind a Slider(-1:0.01:1)

# ╔═╡ 636f16e1-b458-4d38-abe1-92f24d7173da
println(z)

# ╔═╡ 63c880b2-5bba-43e2-81e2-efa880aabe6c
@bind f Select([sin, cos, tan])

# ╔═╡ de2172e1-0c9c-44bb-bb14-f5935004e5cd
begin
    x = -pi:0.01:pi
    y = @. f(x - a)
end

# ╔═╡ cfec83b9-4cb3-4f5d-b6ef-799076b66485
plot(x, y)

# ╔═╡ 08311720-0b8b-4c29-9ec3-4593231e3ad3
testimage("mand")

# ╔═╡ f64c9a4d-4ad8-4f0c-9641-9e9a1613ab0a


# ╔═╡ Cell order:
# ╠═2d9e9e13-f659-4fd3-b318-6bd3016fbc38
# ╠═1a453479-8e69-4c0e-8d2f-4578d5b74353
# ╠═636f16e1-b458-4d38-abe1-92f24d7173da
# ╠═63c880b2-5bba-43e2-81e2-efa880aabe6c
# ╠═de2172e1-0c9c-44bb-bb14-f5935004e5cd
# ╠═cfec83b9-4cb3-4f5d-b6ef-799076b66485
# ╠═08311720-0b8b-4c29-9ec3-4593231e3ad3
# ╠═f64c9a4d-4ad8-4f0c-9641-9e9a1613ab0a